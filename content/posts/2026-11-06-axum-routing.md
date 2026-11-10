---
title: "axum 路由笔记：类型能管的和管不了的"
date: 2026-11-06
tags: ["rust", "axum", "web", "type-system", "design"]
author: tuxnode
---

## TL;DR

axum 的路由看起来是一张表，底下其实叠了三层类型。状态没给，编译不过；提取器顺序写反，编译不过；方法重复了，注册那一刻 panic；路径撞了，也 panic。哪些错误能提前、哪些必须等到启动，界线画得挺清楚，而且基本能从类型上推出来。

下面这些结论都是拿 0.8.9 跑出来的，一共十几组小实验。按这条界线排。

---

## 路由要记住五件事

路由这件事，同时要记住五件事：路径长什么样，这条路径下有哪些方法，handler 要哪些全局对象，中间件盖在哪一段，请求里的东西怎么拆。

老一套做法是把这些塞进同一条注册记录，请求进来再查。axum 把它们拆开了。拆完的副作用是：一部分错误被推到编译期，另一部分仍然只能等启动。

| 维度 | 谁管 | 什么时候查 |
|---|---|---|
| 状态 | `Router<S>` 的类型参数 | 编译期 |
| 提取器组合 | `Handler<T, S>` 的 trait bound | 编译期 |
| 方法分派 | `MethodRouter` 的映射表 | 注册时 panic |
| 路径冲突 | 路由树 | 注册时 panic |
| 中间件顺序 | 链式调用顺序 | 不查 |

最后一行最要命。前面都是「错了会响」，只有中间件是错了不响。

---

## 状态：`S` 是「还差什么」

`Router<S>` 里那个 `S`，第一眼容易理解反。它不是说这个 router 有什么状态，是说它还差什么状态。

- `Router::new()` 给一个 `S` 待定的 router；
- `route()` 要求 handler 能吃下 `S`，于是 `S` 被定住；
- `with_state()` 把实例塞进去，返回 `Router<()>`；
- 只有 `Router<()>` 实现了 `Service<Request>`。

关键在最后一条。状态没给，不会等到运行时才发现，因为 `Router<AppState>` 压根不是个能 serve 的东西。

### 报错永远出现在别处

忘了 `with_state`，错误长这样：

```text
error[E0277]: the trait bound
  `for<'a> Router<AppState>:
     tower_service::Service<IncomingStream<'a, tokio::net::TcpListener>>`
  is not satisfied
```

箭头指在 `serve` 上，不指在你漏掉的那一行。这不是 axum 写得烂，类型状态机都这个毛病：错误出现在约束被用掉的地方，不在约束被破坏的地方。

### 推断也会卡住

我写实验代码的时候把 router 构造包进了 `catch_unwind`，想抓那个重复路由的 panic：

```rust
let r = catch_unwind(AssertUnwindSafe(|| {
    Router::new()          // error[E0283]: cannot infer type of `S`
        .route("/x", get(|| async {}))
        .route("/x", get(|| async {}))
}));
```

编译器当场哑火，说 `cannot infer type of S`。`S` 得从下游推，而 `catch_unwind` 把下游切断了，没东西可推。改成 `Router::<()>::new()` 就过。

日常业务代码很少碰到这个。测试和泛型封装里几乎躲不开，写之前先想好类型标在哪。

### 同一个需求，另一种解法

`Extension` 干的是同一件事，只是不在类型上做。

| 写法 | 缺了会怎样 | 什么时候发现 |
|---|---|---|
| `State<T>` | 编译失败 | 构建期 |
| `Extension<T>` | 500 加一段提示 | 请求期 |
| `Option<Extension<T>>` | 拿到 `None` | 请求期 |

实测差别：

```text
State 缺失          -> error[E0277]，Router<AppState> 不实现 Service
Extension 缺失      -> 500 "Missing request extension: Extension of type
                            `alloc::sync::Arc<Pool>` was not found."
Option<Extension>   -> 200，handler 收到 None
```

`Extension` 是在请求的 `Extensions` 里按 `TypeId` 查。每个请求查一次，编译期什么都不保证。换来的是 router 不用背类型参数。

这一条决定了它在生态里的位置。中间件库没法知道你的 `S` 是什么，而 `Router<S>` 要求所有参与组合的类型共用同一个 `S`，所以 tower 那一圈基本都在用 `Extension`。自己的业务代码没有这个限制，用 `State` 更划算。

---

## 方法分派：一张表，两种错法

路径和方法是两回事。`Router` 管 URL 落到哪个入口，`MethodRouter`（`get(a).post(b)` 那个东西）管入口下面每个方法派给谁。

### 404 和 405 分开

很多框架图省事，把「路径不存在」和「方法不对」都回成 404。axum 分开了。注册 `GET /r` 和 `POST /r` 之后：

```text
DELETE /r   -> 405 Method Not Allowed   allow=Some("GET,HEAD,POST")
GET    /r2  -> 404 Not Found
```

两个地方容易忽略：

- HEAD 是自己加上的。HEAD 就是 GET 去掉响应体，服务端一般默认支持，不用手写。
- 405 带 `Allow` 头，404 不带。前者是「东西在，方法不对」，后者是「东西不在」，缓存和客户端的处理都不一样。

### 重复注册只能 panic

同一路径、不同方法分两次注册，会合到一起：

```text
POST /z -> 200 OK   （get 和 post 分别注册后合并）
```

同一路径、同一方法，直接炸：

```text
panic: Overlapping method route. Handler for `GET /x` already exists
```

这里其实没得选。路径是 `&str`，编译期查不了；静默覆盖更糟，配置写错了根本看不出来。panic 是这两条路之间唯一站得住的那个。

---

## 参数：函数签名就是协议

handler 就是普通 async 函数，参数类型拼起来就是提取协议：

```rust
async fn handler(
    State(pool): State<PgPool>,     // 状态
    Path(id): Path<u64>,            // 路径参数
    Query(q): Query<Filters>,       // 查询串
    Json(body): Json<CreateReq>,    // 请求体
) -> impl IntoResponse { ... }
```

这些参数被打包成一个元组，当作 `Handler<T, S>` 的 `T`。一种元组长度对应一个实现，最多 16 个。

### 碰不碰 body，决定了它能站哪

| trait | 要什么 | 能站哪 |
|---|---|---|
| `FromRequestParts` | `&mut Parts`（头、路径、查询） | 任意位置 |
| `FromRequest` | 完整 `Request`（含 body） | 只能最后 |

body 是一次性的流，读掉就没了。所以碰 body 的提取器最多一个，而且必须压轴。

这条规则没写在文档里让人自己背，是编进 trait bound 的：

- 前 n-1 个位置要 `FromRequestParts<S>`；
- 最后一个位置要 `FromRequest<S, M>`，`M` 是个标记类型。

标记类型是为了绕开 coherence。`FromRequest` 有一条 blanket 实现，能把任何 `FromRequestParts` 抬成 `FromRequest`；不加区分的话，它会和具体类型的手写实现撞车。加个 `M`，两条路走不同的类型参数，编译器就不吵了。

### 写反了会怎样

```rust
async fn handler(body: String, q: RawQuery) -> String
```

```text
error[E0277]: the trait bound
  `fn(String, RawQuery) -> impl Future<Output = String> {handler}: Handler<_, _>`
  is not satisfied
```

它只说组合不成立，不说「String 只能放最后」。把规则编进 trait bound，代价就是编译器能判断、但不会解释。

顺序对调就过，而且没有运行时开销。`from_request_parts` 是静态调用，不是动态派发。

### 失败也是类型

提取器失败不 panic，返回关联类型 `Rejection`，这个类型必须实现 `IntoResponse`：

```text
Json<Req> 合法              -> 200
Json<Req> 语法错误          -> 400 "Failed to parse the request body as JSON: ..."
Content-Type 不是 json      -> 415 "Expected request with `Content-Type: application/json`"
body 为空                   -> 400 "... EOF while parsing a value"
```

状态码是 `Rejection` 自带的，handler 管不着。自定义提取器可以定自己的失败语义，但只要还想当提取器，就得保证失败一定能变成一个响应。

`Rejection` 是关联类型，不是 `Box<dyn Error>`。失败类型写在类型里，调用方想精确匹配就精确匹配，不用往下转型。这比统一成一个大 error 再 `match` 强不少。

---

## 中间件：写在哪儿，就管到哪儿

### layer 和 route_layer 差在哪

两个方法签名几乎一样，行为差得远。拿个计数中间件测一下：

```text
                     GET /hit    GET /nope (404)
.layer(mw)              1            1
.route_layer(mw)        1            0
```

- `layer` 包住已注册路由、用户 fallback、还有内建的 404 fallback；
- `route_layer` 只包已注册路由，fallback 原样不动。

要记日志、打 trace、发请求 ID 的，用 `layer`，404 也得留痕。做认证和限流的，用 `route_layer`，没匹配上的请求不值得花这个钱。

### 链式调用的顺序就是作用域

中间件只作用于它前面注册的路由。

```text
Router::new().layer(mw).route("/a", get(h))
  -> GET /a -> 200 OK, mw hits = 0
```

`layer` 写在 `route` 前面，`/a` 就光着。每次 `layer` 只对当下的路由表做一次映射，写完固定，后面再加的路由跟它没关系。

`route_layer` 遇到这种情况直接 panic：

```text
panic: Adding a route_layer before any routes is a no-op.
       Add the routes you want the layer to apply to first.
```

空 router 上调用也一样 panic。这个检查我认为是对的。`layer` 那种静默忽略，认证中间件写错位置会一点提示都没有，上线之后才发现某个接口裸奔。

### 嵌进去之后

`route_layer` 只管自己那个 router：

```text
GET /api/inside   -> hits = 1
GET /api/outside  -> hits = 0
```

`/api/outside` 在子 router 里找不到，交给外层处理，自然不经过子 router 的 `route_layer`。

---

## nest 和 merge：拼装时还有两套规则

### fallback 到底归谁

```text
A. 子有 fallback，外层也有
     GET /api/nope -> 418 "api fallback"
     GET /nope     -> 404 "root fallback"

B. 子有 fallback，外层是内建 404
     GET /api/nope -> 502 "inner"
     GET /nope     -> 404 ""            （内建响应体为空）

C. 子没有，外层有
     GET /api/nope -> 418 "outer"       （继承外层）
```

一句话：前缀里找不到的，先问子 router 的 fallback，子 router 没有就往外层找。跟「nest 是个独立子应用」的直觉一致。代价是归属得在运行时顺着嵌套链找，读代码时看不出来。

### 同一个 merge，两种检查

```text
Router<()> 与 Router<AppState> 合并
  -> error[E0277]: the trait bound `Router: From<Router<AppState>>` is not satisfied

两个 router 都设置了自定义 fallback
  -> panic: Cannot merge two `Router`s that both have a fallback
```

状态类型编译期就知道；fallback 有没有被设置过，是个运行时的布尔值。axum 内部拿 `default_fallback: bool` 区分内建 404 和用户自己设的，类型里没这个东西，也就查不了。

### 路径冲突

```text
panic: Overlapping method route. Handler for `GET /y` already exists
```

路径是字符串，进不了类型系统。重复注册、merge 撞车，都只能等注册的时候炸。

---

## 一条线

| 约束 | 什么时候查 | 炸成什么样 |
|---|---|---|
| 状态已提供 | 编译期 | `Router<S>` 不实现 `Service` |
| `Extension<T>` 已注入 | 请求期 | 500 |
| 提取器顺序 | 编译期 | `Handler` 未实现 |
| 提取器数量 ≤ 16 | 编译期 | `Handler` 未实现 |
| 方法重复 | 注册期 | panic |
| 路径重叠 | 注册期 | panic |
| fallback 冲突 | 注册期 | panic |
| 中间件是否覆盖某路由 | 不查 | 静默不生效 |
| 中间件顺序是否合理 | 不查 | 由调用位置决定 |

最后两行是这套设计最软的地方。作用域由调用位置决定，而调用位置在类型上根本看不见。`route_layer` 的空 router 检查堵住了一半，`.layer()` 写在 `.route()` 前面那种静默失效，没人管。

---

## 最后

axum 干的事其实是一次分工：跟 handler 有关的约束类型化，跟路由表有关的约束留给运行时。

这个切法不是随便定的。handler 是函数，签名天生就是类型；路由表是配置，天生就是数据。硬要把路由表也编进类型（类型级字符串、宏生成路由），编译时间和报错质量会一起崩，得不偿失。

所以适用面也就清楚了。状态和提取器复杂、想让编译器兜底的服务，收益最大。路由要从配置文件或者插件动态生成的项目，类型参数只会碍事，何况 `route()` 收的就是 `&str`，本来也没法检查。中间件作用域要精细控制的地方，还是得靠文档和测试。

代价主要报在错误信息上。`the trait bound ... is not satisfied` 不会告诉你「忘了 with_state」还是「String 放错位置」，它只知道组合不成立。这是把所有约束往下沉的通病，换谁做都一样。

真要说记住什么，就一条线：类型系统管它看得见的东西，也就是函数签名；看不见的，也就是路由表，只能等注册时检查。想清楚这点，一个错误会出现在编译日志里还是出现在进程启动的第一秒，基本能提前猜出来。

---

## 参考资料

- [axum 0.8 路由文档](https://docs.rs/axum/0.8/axum/routing/index.html) —— `Router`、`MethodRouter`、`nest`、`merge`
- [`Handler` trait](https://docs.rs/axum/0.8/axum/handler/trait.Handler.html) —— 提取器顺序与参数上限
- [`FromRequestParts` 与 `FromRequest`](https://docs.rs/axum/0.8/axum/extract/index.html) —— 两类提取器的分工
- [`Router::route_layer`](https://docs.rs/axum/0.8/axum/struct.Router.html#method.route_layer) —— 作用域差异
- [tower::Service](https://docs.rs/tower/latest/tower/trait.Service.html) —— `Router` 最终落成的抽象
