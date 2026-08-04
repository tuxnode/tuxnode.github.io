---
title: "动态调试xv6内核，复习OS知识"
date: 2026-08-04
tags: ["riscv", "pwn"]
author: tuxnode
---

## TL;DR

很早之前，我就做完了xv6内核的实验，也算是入门了操作系统

xv6小而精的设计思路的确适合初学者入门这样一个复杂的计算机分支

今天经过一定时间的沉淀后，重新来看看当时没有被完全理解，还有一些被一笔带过的知识

## 固件代码

过去，我们只关注到了内核被加载之后的内容，每次调试都是`b _entry`之后

但是在这之前，是时候看看硬件ROM中的代码了

```bash
make qemu-gdb
```

在启动qemu的gdb-server后，程序会暂定执行。此时，我们在另一个终端执行

```bash
gdb-multiarch kernel/kernel
```

就可以自动连接gdb-server。由于是远程连接，没有办法`starti`直接进行调试，只能通过地址打断点

先检查当前的pc，再将当前pc打上断点即可

![pc_image](/pc.png)

接下来就可以查看指令
