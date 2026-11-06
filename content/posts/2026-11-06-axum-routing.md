---
title: "axum 路由设计：三层类型与一条边界"
date: 2026-11-06
tags: ["rust", "axum", "web", "type-system", "design"]
author: tuxnode
---

## TL;DR

多数框架的路由是运行时数据结构：注册规则、填入表、请求到达时查表。错误因此被推迟——路径重复、状态缺失、提取器顺序错误，都要等进程跑起来才暴露。

axum 把其中一部分搬到编译期。同一份路由声明拆成三层：

```text
Router<S>       状态类型 S：handler 还缺什么
  └ MethodRouter<S>   同一路径下的方法分派表
      └ Handler<T, S> 函数签名 T：提取器列表与顺序
```

三层各管一类约束：**状态齐备**由 `Router<()>` 表示，**提取器合法**由 trait bound 决定，**方法重复**由注册期 panic 兜底。

本文按这三层拆解 axum 0.8 的路由设计，用一组实验标出每条约束的实际边界。

---

## 问题的形状

路由要同时表达五个维度：路径、方法、状态、中间件、提取。传统做法把它们塞进同一条注册记录，axum 按生命周期切开：

| 维度 | 载体 | 检查时机 |
|---|---|---|
| 状态 | `Router<S>` 的类型参数 | 编译期 |
| 提取器组合 | `Handler<T, S>` 的 trait bound | 编译期 |
| 方法分派 | `MethodRouter` 的映射表 | 注册时 panic |
| 路径冲突 | 路由树 | 注册时 panic |
| 中间件顺序 | 链式调用顺序 | 无检查 |

这张表划出了整套设计的边界：**能表达为类型的编译期拦住，只能表达为数据的运行时 panic。**

---

## 第一层：`Router<S>`

### S 表示「还缺什么」

- `Router::new()` 产生 `Router<S>`，`S` 待定；
- `.route(path, handler)` 要求 handler 接受 `S`，把 `S` 钉死；
- `.with_state(state)` 提供实例，返回 `Router<()>`；
- 只有 `Router<()>` 实现 `Service<Request>`。

`with_state` 递归注入到 path 与 fallback 的每一层，因此必须发生在该 router 的全部注册之后。缺一步，`S` 就不会退化成 `()`。

### 实验：漏掉 with_state

```text
error[E0277]: the trait bound
  `for<'a> Router<AppState>:
     tower_service::Service<IncomingStream<'a, tokio::net::TcpListener>>`
  is not satisfied
```

错误指向 `serve`，而非漏掉的那行 `.with_state()`。这是类型状态机的固有代价：**错误出现在约束被使用处，不在被破坏处。**

### 代价：类型推断

`S` 需要从下游推导。被 `catch_unwind` 或泛型封装隔断之后，推导失败：

```rust
let r = catch_unwind(AssertUnwindSafe(|| {
    Router::new()          // error[E0283]: cannot infer type of `S`
        .route("/x", get(|| async {}))
        .route("/x", get(|| async {}))
}));
```

此时必须写出 `Router::<()>::new()`。默认参数 `Router<S = ()>` 缓和了常见路径上的负担，但测试代码与泛型封装绕不开显式标注。

### 对照：Extension

`State` 不是传递共享对象的唯一方式。

| 写法 | 缺失时 | 发现时机 |
|---|---|---|
| `State<T>` | 编译失败 | 构建期 |
| `Extension<T>` | 500 + 提示 | 请求期 |
| `Option<Extension<T>>` | 返回 `None` | 请求期 |

```text
State 缺失          -> error[E0277]，Router<AppState> 不实现 Service
Extension 缺失      -> 500 "Missing request extension: Extension of type
                            `alloc::sync::Arc<Pool>` was not found."
Option<Extension>   -> 200，handler 收到 None
```

`Extension` 在请求的 `Extensions` 映射里按 `TypeId` 查找：每次请求多一次查找，且丢失编译期保证。回报是 router 不必携带类型参数，**库可以在不知道宿主 `S` 的前提下注入依赖**。

这正是 tower 生态偏好 `Extension` 的原因：中间件库无法假设 `S` 的类型，而 `Router<S>` 要求所有参与组合的类型共享同一个 `S`。应用自身用 `State`，跨库传递用 `Extension`。

---

## 第二层：`MethodRouter`

路径匹配与方法分派是两件事：`Router` 决定 URL 对应哪个入口，`MethodRouter`（即 `get(a).post(b)`）决定入口下的方法表。

### 404 与 405

多数框架把两者合并，axum 保持严格语义。注册 `GET /r` 与 `POST /r` 后：

```text
DELETE /r   -> 405 Method Not Allowed   allow=Some("GET,HEAD,POST")
GET    /r2  -> 404 Not Found
```

- **HEAD 自动补齐**。HEAD 是 GET 去掉响应体，服务端通常自动支持。
- **405 带 `Allow`，404 不带**。前者资源存在但方法不符，后者资源不存在，缓存语义与客户端处理方式不同。

### 重复注册

同一路径、不同方法分两次注册会合并：

```text
POST /z -> 200 OK   （get 与 post 分别注册后合并）
```

同一路径、同一方法则 panic：

```text
panic: Overlapping method route. Handler for `GET /x` already exists
```

重复注册既不能做成编译错误（路径是 `&str`，不是类型），也不该静默覆盖（会掩盖配置错误）。panic 是唯一可靠的选择。

---

## 第三层：`Handler`

### 函数签名即协议

```rust
async fn handler(
    State(pool): State<PgPool>,     // 状态
    Path(id): Path<u64>,            // 路径参数
    Query(q): Query<Filters>,       // 查询串
    Json(body): Json<CreateReq>,    // 请求体
) -> impl IntoResponse { ... }
```

参数被编码成元组 `(State<PgPool>, Path<u64>, Query<Filters>, Json<CreateReq>)`，作为 `Handler<T, S>` 的 `T`。每个元组长度对应一个实现，上限为 16。

### 两类提取器

| trait | 输入 | 位置 |
|---|---|---|
| `FromRequestParts` | `&mut Parts`（头、路径、查询） | 任意 |
| `FromRequest` | 完整 `Request`（含 body） | 仅末尾 |

body 是一次性的流，消费后无法回退，因此消费 body 的提取器最多出现一次且必须在末尾。

### 类型层面的强制

- 前 n-1 个参数要求 `FromRequestParts<S>`；
- 最后一个要求 `FromRequest<S, M>`，`M` 为**标记类型**。

标记类型用于解决 coherence：`FromRequest` 有一条 blanket 实现，把任何 `FromRequestParts` 提升为 `FromRequest`。若无标记参数，这条 blanket 实现会与具体类型的手写实现重叠；加上 `M` 后，两条路径落在不同参数上，编译器可以同时接受。

于是规则落进类型：前 n-1 个位置只接受 `FromRequestParts`，最后一个接受 `FromRequest`（含由 blanket 提升上来的 `FromRequestParts`）。

### 实验：顺序写反

```rust
async fn handler(body: String, q: RawQuery) -> String
```

```text
error[E0277]: the trait bound
  `fn(String, RawQuery) -> impl Future<Output = String> {handler}: Handler<_, _>`
  is not satisfied
```

报错只说明组合不成立，不说明「String 只能放最后」。这是 trait bound 编码约束的第二个代价：**编译器可以判定，但无法解释。**

对调后即可通过，且无运行时开销——`from_request_parts` 是静态调用。

### 失败路径也是类型

提取器失败返回关联类型 `Rejection`，它必须实现 `IntoResponse`：

```text
Json<Req> 合法              -> 200
Json<Req> 语法错误          -> 400 "Failed to parse the request body as JSON: ..."
Content-Type 不是 json      -> 415 "Expected request with `Content-Type: application/json`"
body 为空                   -> 400 "... EOF while parsing a value"
```

状态码由 `Rejection` 的实现决定，不由 handler 决定。自定义提取器因此能定义自己的失败语义，同时保证「失败必定可转为响应」。

`Rejection` 是关联类型而非 `Box<dyn Error>`：失败类型写在类型里，调用方可精确匹配，不必向下转型。

---

## 中间件的两个作用域

### layer 与 route_layer

签名几乎一致，行为差异很大。用计数中间件测试：

```text
                     GET /hit    GET /nope (404)
.layer(mw)              1            1
.route_layer(mw)        1            0
```

- `layer` 包裹已注册路由、用户 fallback、内建 404 fallback；
- `route_layer` 只包裹已注册路由。

前者适合日志、追踪、请求 ID（404 也要记录），后者适合认证与限流（未匹配的请求不值得付出成本）。

### 顺序语义

**中间件只作用于调用它之前已注册的路由。**

```text
Router::new().layer(mw).route("/a", get(h))
  -> GET /a -> 200 OK, mw hits = 0
```

`layer` 在 `route` 之前调用，`/a` 便没有被包裹。每次 `layer` 只对当下的路由表做一次映射，注册顺序即作用域。

`route_layer` 在同样情况下直接 panic：

```text
panic: Adding a route_layer before any routes is a no-op.
       Add the routes you want the layer to apply to first.
```

对空 router 调用同样 panic。这类检查把静默失效变成立即失败：若沿用 `layer` 的忽略语义，写错位置的认证中间件会静默跳过，且没有任何提示。

### nest 内的作用域

`route_layer` 的作用域是单个 router 实例：

```text
GET /api/inside   -> hits = 1
GET /api/outside  -> hits = 0
```

`/api/outside` 在子 router 中没有对应路由，由外层处理，不经过子 router 的 `route_layer`。

---

## nest 与 merge：运行时拼装

### fallback 归属

```text
A. 子有 fallback，外层也有
     GET /api/nope -> 418 "api fallback"
     GET /nope     -> 404 "root fallback"

B. 子有 fallback，外层为内建 404
     GET /api/nope -> 502 "inner"
     GET /nope     -> 404 ""            （内建响应体为空）

C. 子无 fallback，外层有
     GET /api/nope -> 418 "outer"       （继承外层）
```

规则：**前缀内优先子 router 的 fallback，缺失时向外层继承。** 符合「nest 是独立子应用」的直觉，代价是归属要在运行时沿嵌套链查找。

### 约束

```text
Router<()> 与 Router<AppState> 合并
  -> error[E0277]: the trait bound `Router: From<Router<AppState>>` is not satisfied

两个 router 都设置了自定义 fallback
  -> panic: Cannot merge two `Router`s that both have a fallback
```

同一个 `merge`，状态类型在编译期检查，fallback 冲突在运行时检查。区别在于前者是类型参数，后者是运行时布尔状态——axum 内部用 `default_fallback: bool` 区分内建 404 与用户设置，类型里没有对应表示。

### 路径冲突

```text
panic: Overlapping method route. Handler for `GET /y` already exists
```

路径是字符串，无法参与类型检查。重复注册、merge 重叠，都只能等注册期 panic。

---

## 边界

| 约束 | 检查时机 | 失败表现 |
|---|---|---|
| 状态已提供 | 编译期 | `Router<S>` 不实现 `Service` |
| `Extension<T>` 已注入 | 请求期 | 500 |
| 提取器顺序 | 编译期 | `Handler` 未实现 |
| 提取器数量 ≤ 16 | 编译期 | `Handler` 未实现 |
| 方法重复 | 注册期 | panic |
| 路径重叠 | 注册期 | panic |
| fallback 冲突 | 注册期 | panic |
| 中间件是否覆盖某路由 | 无 | 静默不生效 |
| 中间件顺序是否合理 | 无 | 由调用顺序决定 |

最后两行是最薄弱处：作用域由调用位置隐式决定，而调用位置在类型上不可见。`route_layer` 的空路由检查覆盖了一部分，`.layer()` 写在 `.route()` 之前的静默失效没有对应检查。

---

## 取舍

**收益**

- 状态缺失无法上线，由类型系统保证，不依赖测试；
- 提取器顺序错误无法上线；
- 方法分派表在注册期校验，重复立即失败；
- handler 适配单态化，无动态派发。

**成本**

- 错误信息与错误位置分离：漏 `with_state` 报在 `serve`，顺序写反只说 `Handler` 未实现；
- 类型推断负担：`Router::<()>::new()` 在测试与泛型封装中不可避免；
- 路由表不可组合为类型：路径、方法、fallback 只能 panic；
- 中间件作用域不可见。

切分逻辑是：**与 handler 相关的约束类型化，与路由表相关的约束留给运行时。** handler 是函数，签名天然是类型；路由表是配置，形态天然是数据。强行把路由表类型化（类型级字符串、宏生成路由），会把编译时间与错误信息推向另一个极端。

适用边界也由此确定：

- 状态与提取器复杂、希望编译期兜底的服务，收益最大；
- 路由需要动态生成（配置文件、插件加载），类型参数成为负担，且 `route()` 的 `&str` 本来就不支持编译期检查；
- 需要精细控制中间件作用域的项目，仍要依赖文档与测试。

---

## End

axum 的路由设计是一次职责切分：把「handler 需要什么」交给类型参数，把「路由表长什么样」交给运行时数据。

三层各解决一类问题。`Router<S>` 用类型状态机保证状态齐备，`Handler<T, S>` 用元组与 trait bound 保证提取器组合合法，`MethodRouter` 退回普通映射表，用 panic 处理重复与冲突。

代价集中在错误信息的可读性上。`the trait bound ... is not satisfied` 无法说明「漏掉了 with_state」或「String 只能放最后」，只能说明组合不成立。这是把约束下沉到类型系统的通用代价，不是 axum 的实现缺陷。

值得记住的是那条线：**类型系统覆盖它看得到的东西，也就是函数签名；看不到的东西，也就是路由表，只能靠注册期检查。** 据此可以预判一个错误会出现在编译日志里，还是出现在进程启动的第一秒。

---

## 参考资料

- [axum 0.8 路由文档](https://docs.rs/axum/0.8/axum/routing/index.html) —— `Router`、`MethodRouter`、`nest`、`merge`
- [`Handler` trait](https://docs.rs/axum/0.8/axum/handler/trait.Handler.html) —— 提取器顺序与参数上限
- [`FromRequestParts` 与 `FromRequest`](https://docs.rs/axum/0.8/axum/extract/index.html) —— 两类提取器的分工
- [`Router::route_layer`](https://docs.rs/axum/0.8/axum/struct.Router.html#method.route_layer) —— 作用域差异
- [tower::Service](https://docs.rs/tower/latest/tower/trait.Service.html) —— `Router` 最终落成的抽象
