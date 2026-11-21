---
title: "bustub的多线程共享读锁设计"
date: 2026-11-21
tags: ["cpp", "datebase", "async", "design"]
author: tuxnode
---

## TL;DR
在做[bustub](https://github.com/cmu-db/bustub) 实验的[Project 1](https://15445.courses.cs.cmu.edu/spring2026/project1/)时，在实现`BufferPoolManager`时，就需要开始接触C++-17的并发编程。

一开始最容易写出来的版本，是给整个`BufferPoolManager`配一把大锁。可以运行，但它把本不相关的操作也串成了一条队列。

所以这套设计的重点并不是“加了几把锁”，而是两个更基本的判断：

- 锁的粒度应该对齐数据的归属。页面数据归`FrameHeader`，全局元数据归`BufferPoolManager`，谁的数据谁来锁，无关的线程自然就不会互相等
- 锁的生命周期应该托管给持有它的对象。`PageGuard`把“加锁、pin、解锁、unpin”收成一次构造和一次析构，顺序不再靠人记

前者决定并行度，后者决定正确性。

## 三层架构

在阅读到[BufferPoolManager](https://github.com/cmu-db/bustub/blob/master/src/include/buffer/buffer_pool_manager.h)的代码时，我们可以发现`BufferPoolManager`只是扮演了一个调度者的角色，负责全局路由与生命周期编排。提供`NewPage()`这样的接口提供给上层调用。

它的核心作用是维护一个固定大小的**缓冲区**，并负责**Disk Page**的换入、换出以及**脏页写回** 。它是内存缓冲区的维护者

既然定位清晰了，那么它要实现的目的也就很清晰:

- 保证容量和ID映射的边界
- 保证脏页写回的持久化语义
- 并发与锁安全，避免发生Race Condation和Dead Lock
- 安全地与磁盘调度进行交互

既然如此，设置足够细致的锁，管理好对象生命周期就很有必要。

目前我们面临着三个抽象: 
[source code](https://github.com/cmu-db/bustub/blob/master/src/include/buffer/buffer_pool_manager.h)

> `FrameHeader`: 持有原子计数和共享互斥锁, 并真正存储数据的结构体
>`ReadPageGuard/WritePageGuard`： 进行了RAII封装的BufferPage读写锁
>`BufferPoolManager`：管理和调度Buffer的中心

### 锁的保护范围和访问语义

要看懂BufferPoolManager中的锁设计，首先要确认其锁的访问边界

bustub中的`bpm_latch_`：保护的是缓冲池全局元数据（page_table_, frames_,ArcReplacer_等）。如果所有页面读/写都用一把 bpm_latch_ ，哪怕线程 A 读 1 号页、线程 B 读 2 号页，也得互相排队。所以在`FrameHeader`中，会有单独的`std::shared_mutex`管理。

### 追踪一个锁的生命周期

在观察架构的时候，会发现`BufferPoolManager`和`PageGuard`的成员变量都不是真正设置一个锁，而是设置一个`shared_ptr`指向一个`std::mutex`（其中FrameHeader是成员变量有一个`std::shared_mutex`，这个是另外一个设计了）,这些指针在构造函数中通过参数传递进来。

那么先看一段代码
```C++
struct UnsafeBPM {
  std::mutex bpm_latch_;
  ~UnsafeBPM() { std::cout << "UnsafeBPM Drop" << std::endl; }
};

struct UnsafeGuard {
  std::mutex &latch_;
  bool active_{true};
  explicit UnsafeGuard(std::mutex &latch) : latch_(latch) {}

  ~UnsafeGuard() {
    if (active_) {
      // 如果 UnsafeBPM 已经先析构，这里访问的是已销毁的 std::mutex（UAF）
      std::lock_guard<std::mutex> lock(latch_);
      std::cout << "[UnsafeGuard] cleanup under bpm_latch_" << std::endl;
    }
  }
};
```
>可以明显发现`PageGuard`无法安全地持有它的生命周期，`PageGuard`在Drop()时需要这把锁去更新`ArcReplacer`的数据。
>一旦`PageGuard`的生命周期长于`BufferPoolManager`（一般来源于错误的代码或析构顺序），就会发生上述的UAF

### PageGuard的RAII封装

为了将单独将内存页的`并发安全读写 + 维护引用计数 + 自动释放锁 + 不会淘汰正在使用的BufferPage`这些需求单独抽象出来

bustub专门设计了PageGuard用来封装对Page进行操作时，需要管理的锁，线程安全等细节。它的生命周期默认小于`BufferPollManager`。

但“默认小于”只是约定，不是保证。上文的`UnsafeGuard`之所以会炸，是因为它裸引用了一把不属于自己的锁。bustub的解法是把所有权也表达出来:

```C++
struct SafeGuard {
  std::shared_ptr<FrameHeader> frame_;     // 帧活到最后一个 guard 结束
  std::shared_ptr<std::mutex> bpm_latch_;  // 全局锁同理
  bool active_{true};

  SafeGuard(std::shared_ptr<FrameHeader> frame, std::shared_ptr<std::mutex> latch)
      : frame_(std::move(frame)), bpm_latch_(std::move(latch)) {
    frame_->rwlatch_.lock_shared();    // 先拿到锁，才有资格读页面
    frame_->pin_count_.fetch_add(1);
  }

  ~SafeGuard() {
    if (active_) {
      frame_->pin_count_.fetch_sub(1);
      frame_->rwlatch_.unlock_shared();
      std::lock_guard<std::mutex> lock(*bpm_latch_);
      // 到这里才把 frame 交还给 replacer，成为可淘汰候选
    }
  }
};
```

那么顺序上的细节也就清楚了:

- 构造时先加锁，再`pin_count_++`。反过来就会留一个窗口，帧还没被pin住就可能被淘汰，守卫拿到的是一张已经换出去的页
- 析构时先`pin_count_--`，再解锁，最后才去碰`bpm_latch_`。前两步是页面级操作，不需要全局锁
- `shared_ptr`只保证锁对象本身不悬垂。guard还要回写`ArcReplacer_`，所以它引用的BPM也得一起延命，这才是两层`shared_ptr`真正的用处

### pin_count_ 为什么是 std::atomic

上文的`SafeGuard`里，`pin_count_`是直接`fetch_add`的，没有经过任何一把锁。这不是设计缺陷，而是它很难交给锁来管。

```C++
struct FrameHeader {
  std::shared_mutex rwlatch_;          // 保护页里的数据
  std::atomic<size_t> pin_count_{0};   // 原子引用
  std::atomic<bool> is_dirty_{false};
};
```

两个看起来可行的替代方案都不太成立:

- 交给`bpm_latch_`。guard的构造和析构在每次取页、放页时都会发生，把这些都塞进全局锁，分层就白做了
- 交给帧自己的`rwlatch_`。淘汰线程判断"这个帧能不能回收"时还没拿到页锁（拿到了就不用淘汰了），用页锁去保护pin，等于要求它先拿锁才能看到计数

所以这个计数器的归属虽然也是`Frame`，但它的读取者并不持有页锁，只能自己保证原子性。这是"锁粒度对齐数据归属"的一个边界情形: 数据归属清楚，不代表锁能覆盖到所有访问者。

不过`atomic`只解决"计数不撕裂、不丢更新"，不解决"看到0就拿来用"。淘汰时`pin_count_ == 0`的检查和后续的占用之间仍然有窗口，这一段还是要回到`bpm_latch_`里完成，或者拿到frame锁之后再复核一次。原子变量是让这个窗口不被计数器的读写本身放大，而不是让窗口消失。

### 锁顺序与死锁

分层换来了并行度，代价是可能出现嵌套获取。只要存在嵌套，就必须有全局的加锁顺序。这个实现里遵守的规则只有一条:

> 需要同时持有两把锁时，永远先`bpm_latch_`，再frame latch。任何“握着frame latch去拿`bpm_latch_`”的写法都是bug

```
      bpm_latch_  ─────────────── 外层: page_table_ / frames_ / ArcReplacer_
           │
           ├── FrameHeader#1.rwlatch_ ─┐
           ├── FrameHeader#2.rwlatch_  ├─ 内层: 页面数据，读读可并行
           └── FrameHeader#3.rwlatch_ ─┘
```

按这个顺序，外层永远是唯一入口，内层锁之间互不嵌套，形不成环，也就没有死锁。

反过来写就有问题了。线程A先拿`FrameHeader#1`的锁再去拿`bpm_latch_`，线程B先拿`bpm_latch_`再去拿`FrameHeader#1`的锁，两者各持一把等对方，标准的ABBA死锁。

还有两处容易忽略的隐式反向加锁:

- 持有frame latch时调用任何会碰`page_table_`或`ArcReplacer_`的函数，等于偷偷按反序加锁。这类计算要么在进临界区前做完，要么把结果传出去再处理
- 想把读guard原地升级成写guard，不要直接再`lock()`一次。`std::shared_mutex`不是递归锁，同一线程二次获取会直接卡死。正确做法是先释放读guard，再重新以写模式获取

这两点，三层结构就能既保住并行度，又不需要额外的死锁检测。