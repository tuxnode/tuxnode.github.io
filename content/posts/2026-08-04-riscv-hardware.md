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


