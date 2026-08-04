---
title: "动态调试xv6内核，复习OS知识"
date: 2026-08-04
tags: ["riscv", "pwn"]
author: tuxnode
---

## TL;DR

很早之前，我就做完了[xv6内核](https://pdos.csail.mit.edu/6.828/2025/xv6/book-riscv-rev5.pdf)的实验，也算是入门了操作系统

xv6小而精的设计思路的确适合初学者入门这样一个复杂的计算机分支

今天经过一定时间的沉淀后，重新来看看当时没有被完全理解，还有一些被一笔带过的知识

---

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

接下来就可以查看指令。如果gdb中反汇编不方便查看，在gdb中执行`(gdb) monitor pmemsave 0x1000 0x1000 bootrom.bin`就可以将对应的内存dump出来

通过objdump就可以反汇编

```bash
# 由于没有元数据，所以必须要显式指定参数
riscv64-unknown-elf-objdump \
  -b binary \
  -m riscv:rv64 \
  --adjust-vma=0x1000 \
  -D bootrom.bin > bootrom.asm
```

下面就是QEMU riscv [virt](https://www.qemu.org/docs/master/system/riscv/virt.html)平台的BootROM代码

```asm
0000000000000100 <.data>:
 100:	00000297          	auipc	t0,0x0
 104:	02828613          	addi	a2,t0,40 # 0x128
 108:	f1402573          	csrr	a0,mhartid
 10c:	0202b583          	ld	a1,32(t0)
 110:	0182b283          	ld	t0,24(t0)
 114:	00028067          	jr	t0
```

> virt实际上只是一个虚拟主板，它将CPU，DRAM，DISK等硬件串联在一起
>
> QEMU在启动的时候就会根据virt标准，构建出一个标准的Memory Map的主板布局，并分配好各个硬件的地址空间

所以CPU在刚上电的时候，首先就会执行QEMU virt中的ROM代码。我们看到的反汇编只是QEMU virt的实现而已，但并不影响学习

由于virt主板是虚拟的，所以执行代码也非常简单，省去了很多复杂的流程。例如：配置 PLL 锁相环，给 CPU 和外设倍频/供电等。

在真实的环境中，BootROM要做复杂的`物理硬件初始化`

**此时，CPU处于M-Mode（机器模式）**

---

## Boot Protocol

Boot Protocol是指硬件固件在将 CPU 控制权转交给操作系统内核的时候，双方必须共同遵守的规范

所以上面的几行汇编代码完全就是满足[riscv的boot protocol](https://docs.kernel.org/arch/riscv/boot.html)

根据文档中的描述

需要加载*a0*存放当前CPU核心的ID，*a1*存放`设备树`的物理地址

> 在真实的物理硬件中，设备树通常是在事先编译好并写死在非易失性存储器中

---

## 虚拟内存 and MMU

虚拟内存这层，xv6 是在物理地址上直接搭起来的。MMU 开启之前，整个系统还处于裸机状态，页表树必须靠普通 C 代码写进物理内存。整个过程可以拆成四步

### 裸机物理模式准备

`_entry` 到 start() 的汇编只有几行。先给 C 语言分配运行栈 stack0，在 M-Mode 下设置 mstatus，把降权目标指向 S-Mode，再把 mepc 写成 main() 的地址。w_satp(0) 这一句显式禁用了 MMU。从此刻起，指令取指和内存读写全部直接作用在物理 RAM 上

### 建立物理内存分配器

进入 main() 之后，第一件事是 kinit()。它在 S-Mode 下初始化物理内存管理，把空闲页串成单链表 freelist

这里藏着一个顺序问题：页表本身也要消耗物理内存页来存放页表项，所以 kalloc() 必须在 MMU 开启之前就准备就绪。先有分配器，后有页表，页表树才有地方落脚

### 在物理 RAM 中“手绘”页表树

kvminit() 负责画整棵树。第一步通过 kalloc() 拿出一页 4KB 物理内存作为根页表（L2）

接着 kvmmap 建立恒等映射：对外设 MMIO（UART0、PLIC、VIRTIO0）以及内核代码/数据段（KERNBASE 到 PHYSTOP），全部映射成 VA = PA。权限也做了区分，代码段是 PTE_R | PTE_X，只读可执行；数据段和堆内存是 PTE_R | PTE_W，可读写但不可执行

唯一打破恒等映射的是跳板页 TRAMPOLINE。它被映射到内核虚拟地址的最高端，为后续用户态/内核态的安全切换做准备

底层的建树工作由 mappages 和 walk 完成。遍历虚拟地址时，如果发现缺失 L1/L0 子页表，walk() 会自动调用 kalloc() 动态分配新的 4KB 页表页，最后把二进制页号（PPN）和标志位（如 PTE_V）直接按位拼装，写进物理内存

### 激活 MMU

树画完了，剩下就是挂载

kvminithart() 执行 w_satp(MAKE_SATP(kernel_pagetable))，底层就是一条 csrw satp, a0。指令落下的瞬间，硬件 MMU 被切换成 Sv39 模式。紧随其后的 sfence.vma 清空 TLB，保证 MMU 从物理内存重新加载最新的映射

### 三个值得记住的点

把整个过程收拢一下：

- 先有分配器，后有页表。kalloc() 在 MMU 开启前就能直接管理物理内存，页表树的每个节点都从它这里拿存储空间
- 恒等映射保证平滑过渡。内核代码段采用 VA = PA 的映射，CPU 写入 satp 激活 MMU 的那一瞬间，指令流水线的 PC 不会因地址突变而触发缺页异常
- kvmmap 是数据填充，不是系统调用。它只是一个普通 C 函数，通过原生指针直接往物理内存里写 pte_t 页表项，为 MMU 预先准备好推导地图


