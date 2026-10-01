---
title: "如何解析编程语言表达式"
date: 2026-09-30
tags: ["compiler", "pa"]
author: tuxnode
---

## TL;DR

这个是在做 [NJU PA](https://nju-projectn.github.io/ics-pa-gitbook/ics2024/) 时，引出的一个问题。

同时也和编译原理强相关，所以也算是编译原理的基础内容学习。

---

## 一个表达式包含什么

### 词法分析

表达式解析器的第一步是**词法分析**：将原始字符流切分成一个个有意义的 `Token`。

这些 `Token` 包含关键字、标识符、运算符、常量、分隔符等。

对于这些 Token 的识别，本质上是**正则语言**的匹配问题。每个 Token 类型对应一个正则表达式：

```
INTEGER   : [0-9]+
IDENT     : [a-zA-Z_][a-zA-Z0-9_]*
PLUS      : \+
MINUS     : -
MUL       : \*
DIV       : /
LPAREN    : \(
RPAREN    : \)
```

词法分析器的核心任务是：给定输入字符串，按照优先级匹配最长前缀，输出 Token 流。

> **NJU PA 实战经验**：在 PA 中实现 `expr` 命令时，最容易踩坑的是**负号的歧义**——既是减法运算符，也是负数前缀。词法层面很难区分，通常交给语法分析阶段根据上下文决定。

#### 从正则到 DFA

理论上，词法分析可以通过正则表达式 → NFA → DFA → 最小化 DFA 的流程自动生成。工程上常用工具：

- **Flex / Lex**：生成基于 DFA 的高性能词法分析器
- **手写**：适合简单语言，控制力强，便于错误恢复

---

### 语法分析

拿到 Token 流后，语法分析的任务是根据**文法**构建语法树（AST）。

#### 表达式文法

最简单的算术表达式文法（存在左递归，不适合 LL(1)）：

```
expr    : expr + term
        | expr - term
        | term

term    : term * factor
        | term / factor
        | factor

factor  : ( expr )
        | NUMBER
        | IDENT
```

**左递归**会导致递归下降解析器无限递归。消除左递归后：

```
expr    : term expr_tail
expr_tail: + term expr_tail
         | - term expr_tail
         | ε

term    : factor term_tail
term_tail: * factor term_tail
         | / factor term_tail
         | ε

factor  : ( expr )
        | NUMBER
        | IDENT
```

> **NJU PA 实战经验**：PA 的表达式还支持指针解引用 `*expr`、取地址 `&expr`、数组下标 `expr[expr]`、结构体成员 `expr.ident` 等。文法要相应扩展 `factor` 和 `primary`。

#### 递归下降解析器

每个非终结符对应一个函数，代码结构清晰对应文法：

```c
// 伪码：expr → term expr_tail
Node* parse_expr() {
    Node* left = parse_term();
    return parse_expr_tail(left);
}

Node* parse_expr_tail(Node* left) {
    if (match(PLUS)) {
        Node* right = parse_term();
        return parse_expr_tail(new_node(ADD, left, right));
    }
    if (match(MINUS)) {
        Node* right = parse_term();
        return parse_expr_tail(new_node(SUB, left, right));
    }
    return left;  // ε
}
```

这种写法自然体现了**运算符优先级**：`expr` 处理加减，`term` 处理乘除，`factor` 处理原子单元。层级越深，优先级越高。

---

### 运算符优先级与结合性

#### 优先级表

| 优先级 | 运算符 | 结合性 | 说明 |
|--------|--------|--------|------|
| 1 (最高) | `()` `[]` `.` `->` | 左 | 函数调用、下标、成员访问 |
| 2 | `++` `--` `*` `&` `+` `-` `~` `!` | 右 | 后缀/前缀一元运算符 |
| 3 | `*` `/` `%` | 左 | 乘除模 |
| 4 | `+` `-` | 左 | 加减 |
| 5 | `<<` `>>` | 左 | 移位 |
| ... | ... | ... | ... |

#### Pratt Parser（Top-Down Operator Precedence）

递归下降虽然直观，但每增加一个优先级就要新增一层函数。Pratt Parser 用**绑定力**统一处理：

```c
// 伪码：核心思路
Node* parse_expression(int min_bp) {
    Node* left = parse_primary();  // 解析原子表达式

    while (true) {
        Token op = peek();
        int bp = get_binding_power(op);  // 获取运算符绑定力
        if (bp < min_bp) break;

        advance();
        int next_min_bp = is_right_assoc(op) ? bp : bp + 1;
        Node* right = parse_expression(next_min_bp);
        left = new_node(op, left, right);
    }
    return left;
}
```

**绑定力** = 优先级 × 2 + (左结合 ? 1 : 0)。比如 `+` 绑定力 10，`*` 绑定力 20。

> **NJU PA 实战经验**：PA 中表达式求值器采用类似思想，用 `eval` 递归下降配合优先级参数，比写十几层函数清晰得多。

#### Shunting-yard 算法

Dijkstra 提出的中缀转后缀（RPN）算法，核心是**双栈**：

- 操作数栈
- 运算符栈

遇到运算符时，根据优先级决定是先弹出栈顶运算符计算，还是压栈。最后生成后缀表达式，再用单栈求值。

---

### AST 构建与遍历

语法分析的产物是**抽象语法树**，去除了文法细节，只保留语义结构。

#### 节点设计

```c
typedef enum {
    NODE_ADD, NODE_SUB, NODE_MUL, NODE_DIV,
    NODE_NUM, NODE_IDENT, NODE_NEG, NODE_DEREF, ...
} NodeType;

typedef struct Node {
    NodeType type;
    struct Node *left, *right;  // 二元运算
    struct Node *operand;       // 一元运算
    long value;                 // 常量
    char *name;                 // 标识符
} Node;
```

#### Visitor 模式遍历

将遍历逻辑与节点结构解耦，便于实现求值、打印、类型检查、代码生成等多种操作：

```c
// 求值 visitor
long eval(Node* node) {
    switch (node->type) {
        case NODE_NUM:   return node->value;
        case NODE_ADD:   return eval(node->left) + eval(node->right);
        case NODE_SUB:   return eval(node->left) - eval(node->right);
        case NODE_MUL:   return eval(node->left) * eval(node->right);
        case NODE_DIV:   return eval(node->left) / eval(node->right);
        case NODE_NEG:   return -eval(node->operand);
        case NODE_IDENT: return lookup_var(node->name);
        // ...
    }
}
```

> **NJU PA 实战经验**：PA 的 `expr` 命令本质就是一个解释器。构建 AST 后，`eval` 遍历求值。难点在于**变量查找**（符号表）、**指针运算**、**内存读取**（如 `*(int*)0x80000000` 需要访问客户机内存）。

---

### 错误恢复与报错

实际解析器必须能处理错误输入，而不是直接崩溃。

#### Panic Mode Recovery

遇到错误时，跳过 Token 直到同步点（如 `;`、`}`、换行）：

```c
void synchronize() {
    while (!at_end()) {
        if (previous().type == SEMICOLON) return;
        switch (peek().type) {
            case IF: case WHILE: case FOR: case RETURN: return;
        }
        advance();
    }
}
```

#### 有意义的错误信息

好的报错包含：**位置**、**期望什么**、**实际看到什么**、**修复建议**：

```
error: expected ')' after expression
  --> test.c:10:15
   |
10 |     x = (1 + 2;
   |               ^ expected ')', found EOF
   |
help: try adding a closing parenthesis
```

---

## 总结

| 阶段 | 核心任务 | 关键技术 |
|------|----------|----------|
| 词法分析 | 字符流 → Token 流 | 正则/DFA、Flex、手写 Lexer |
| 语法分析 | Token 流 → AST | 递归下降、Pratt Parser、消除左递归 |
| 语义处理 | AST → 语义值 | Visitor 模式、符号表、类型检查 |
| 错误处理 | 非法输入 → 友好报错 | Panic mode、同步点、诊断信息 |

表达式解析是编译器前端的缩影。掌握了它，处理语句、声明、类型系统就只是规模扩大的问题。

---

## 参考资料

- [Crafting Interpreters - Parsing Expressions](https://craftinginterpreters.com/parsing-expressions.html) —— Pratt Parser 讲解极佳
- [龙书] 编译原理：原理、技术与工具 —— 经典教材
- [NJU ICS PA 文档](https://nju-projectn.github.io/ics-pa-gitbook/ics2024/) —— 实战参考