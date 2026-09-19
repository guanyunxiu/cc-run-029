# Mini SQL — 浏览器端 SQL 查询引擎与测试套件

一个完全运行在浏览器中的关系型 SQL 引擎：打开页面即可建表、插入数据、编写 SQL、
查看结果与执行计划。数据持久化在 **IndexedDB**，查询执行放在 **Web Worker**，
不阻塞界面。SQL 引擎（词法分析、语法分析、绑定、优化、执行）全部自研，
**未使用** sql.js / AlaSQL 或任何 SQL 解析库。

## 快速开始

```bash
npm install
npm run dev        # 启动 Vite 开发服务器（http://localhost:5173）
npm run build      # 类型检查 + 生产构建
npm test           # 运行内置测试套件（Node + esbuild，129 个用例）
```

## 支持的 SQL 特性

### DML / DDL / 事务

| 类别 | 语句 |
| --- | --- |
| 建表/删表 | `CREATE TABLE [IF NOT EXISTS]`、`DROP TABLE [IF EXISTS]` |
| 索引 | `CREATE [UNIQUE] INDEX`、`DROP INDEX`（单列；主键自动索引） |
| 增删改 | `INSERT INTO ... VALUES`、`INSERT ... SELECT`、`UPDATE`、`DELETE` |
| 事务 | `BEGIN` / `COMMIT` / `ROLLBACK`（单写多读、undo log、提交冲突回滚） |
| 其它 | `EXPLAIN SELECT ...` |

- 列约束：`PRIMARY KEY`、`AUTOINCREMENT`（仅 INTEGER 主键）、`NOT NULL`、`UNIQUE`。
- 类型：`INTEGER`、`REAL`、`TEXT`、`BOOLEAN`（兼容 `INT/VARCHAR/FLOAT/BOOL` 等别名）。

### SELECT

- `WHERE`、`ORDER BY`（含 `ASC/DESC`、`NULLS FIRST/LAST`）、`LIMIT`、`OFFSET`
  （含 `LIMIT off, count` 语法）、`GROUP BY`、`HAVING`、`DISTINCT`。
- 列别名与表别名；`t.*` 星标展开；FROM 子查询；ORDER BY 输出别名/位置序号。
- `INNER JOIN`、`LEFT JOIN`（含逗号隐式连接、无 ON 笛卡尔积、多表连接）。
- 子查询：`IN (SELECT ...)`、`[NOT] EXISTS`、标量子查询（SELECT 列表 / WHERE），
  支持相关子查询（含跨层引用）。
- 聚合：`COUNT(*)`、`COUNT(col)`、`SUM`、`AVG`、`MIN`、`MAX`，支持 `DISTINCT`。

### 表达式

- 算术 `+ - * / %`、比较 `= <> < <= > >=`、逻辑 `AND OR NOT`。
- `BETWEEN`、`IN (列表)`、`LIKE`（`%`、`_`）、`IS [NOT] NULL`、`IS [NOT] TRUE/FALSE`。
- `CASE WHEN ... THEN ... ELSE ... END`（搜索式与简单式）、`CAST(expr AS type)`。
- NULL 采用 **三值逻辑**（TRUE / FALSE / UNKNOWN）；`NULL` 比较、算术、IN、
  聚合均符合 SQL 语义。

## 架构

```
SQL 文本
  │
  ▼
Tokenizer（词法分析，token 携带行列号）
  │
  ▼
Parser（递归下降，生成 AST）
  │
  ▼
Binder（名称解析、作用域、相关子查询、聚合重写）
  │
  ▼
Logical Plan（scan/filter/project/join/aggregate/sort/limit/distinct）
  │
  ▼
Optimizer（规则优化）
  │  · 常量折叠      · 谓词下推（含 LEFT JOIN 保护）
  │  · 索引选择（主键/单列，等值 EQ 与范围 RANGE）
  │  · JOIN 实现选择（等值 → Hash Join，否则嵌套循环）
  ▼
Physical Plan（火山模型：open/next/close）
  │
  ▼
TableStore（行存储 + 主键/二级索引）  ──undo log──▶  Transaction
  │
  ▼
StorageBackend（Memory 测试用 / IndexedDB 浏览器持久化）
```

关键目录：

- `src/sql/` — `lexer.ts`（词法）、`parser.ts`（语法）、`ast.ts`、`types.ts`（类型/转换）。
- `src/engine/` — `binder.ts`、`optimizer.ts`、`logical-plan.ts`、`executor.ts`（火山算子）、
  `physical-builder.ts`、`database.ts`（目录/事务/索引）、`table-store.ts`、
  `storage-interface.ts`、`memory-storage.ts`、`idb-storage.ts`、
  `subquery-runtime.ts`、`import-export.ts`、`engine.ts`。
- `src/worker/sql.worker.ts` — 后台执行线程。
- `src/ui/` — 原生 DOM/CSS 界面（无前端框架）。
- `test/` — 129 个用例，覆盖增删改查、JOIN、聚合、子查询、NULL、类型转换、
  边界、错误（含行列号）、事务、索引、导入导出与 IndexedDB 持久化。

## 执行计划（EXPLAIN）

计划中会展示：扫描（`SeqScan` / `IndexScan`）、过滤 `Filter`、投影 `Project`、
连接（`NestedLoopJoin` / `HashJoin`）、聚合 `HashAggregate`、排序 `Sort`、
`Limit`、`HashDistinct`，并标注是否走索引（索引名、EQ/RANGE、条件），
以及扫描行数、索引查找次数、常量折叠/谓词下推数量等统计。

## 存储与并发模型

- 固定两个 IndexedDB 对象仓库（catalog / rows）+ meta 版本号，建表无需升级 DB 版本；
  一个写事务内的全部改动在单个 IndexedDB `readwrite` 事务中原子提交。
- 写操作经引擎内互斥队列串行化（**单写**），读不加锁（**多读**）。
- 提交时校验基础版本号，版本不一致判定为写冲突，回滚并报错。
- 显式事务中某条语句失败后，事务进入 aborted 状态，只允许 `ROLLBACK`。

## 界面

SQL 编辑器（`Ctrl/Cmd+Enter` 执行）、结果表格、消息面板（错误带行列号）、
执行计划、左侧表结构树（点击表名查看数据），以及整库 JSON 导出/导入与
单表 CSV 导入。
