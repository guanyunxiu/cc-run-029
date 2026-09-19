# 浏览器端 SQL 查询引擎与测试套件

一个完全运行在浏览器里的轻量 SQL 数据库：**打开页面即可建表、插数据、写 SQL、查看结果与执行计划**。
数据存 IndexedDB，执行在 Web Worker 中进行，不阻塞界面。SQL 解析器、执行器、事务、索引全部自研，
**不依赖 sql.js / AlaSQL / 任何 SQL 解析库**。

## 快速开始

```bash
npm install
npm run dev        # 启动开发服务器，打开浏览器访问提示地址
npm test           # 运行全部测试（107 个用例）
npm run build      # 类型检查 + 生产构建到 dist/
npm run preview    # 预览生产构建
```

打开页面后：

1. 左侧查看表结构，点击表名可浏览数据；
2. 中间编辑器写 SQL，`Ctrl+Enter` 执行，或点「执行计划」查看 `EXPLAIN`；
3. 顶部「导入 / 导出」支持 JSON（整库）、SQL 脚本、单表 CSV；
4. 点「载入示例数据」快速体验 JOIN + 聚合 + HAVING + ORDER BY。

## 支持的 SQL 能力

| 类别 | 支持内容 |
| --- | --- |
| DDL | `CREATE TABLE`（含 `PRIMARY KEY` / `NOT NULL` / `UNIQUE` / `DEFAULT`）、`DROP TABLE`、`CREATE [UNIQUE] INDEX`、`DROP INDEX`、`IF [NOT] EXISTS` |
| DML | `INSERT`（多行 `VALUES`）、`UPDATE`（表达式赋值）、`DELETE` |
| 查询 | `SELECT ... FROM`、`WHERE`、`ORDER BY`（ASC/DESC，NULL 最前/最后）、`LIMIT`、`OFFSET`、`GROUP BY`、`HAVING`、`DISTINCT`、列/表别名、`*` 与 `表.*` |
| JOIN | `INNER JOIN ... ON`、`LEFT [OUTER] JOIN ... ON`、逗号笛卡尔积 |
| 子查询 | `IN (subquery)`、`EXISTS` / `NOT EXISTS`（支持关联子查询）、SELECT 列表与 WHERE 中的标量子查询、FROM 派生表 |
| 聚合 | `COUNT(*)`、`COUNT(col)`、`SUM`、`AVG`、`MIN`、`MAX`，均支持 `DISTINCT` |
| 表达式 | `+ - * / %`、比较运算、`AND / OR / NOT`（三值逻辑）、`BETWEEN`、`IN`、`LIKE`（`%`、`_`，大小写不敏感）、`IS [NOT] NULL`、搜索/简单 `CASE`、`CAST` |
| 函数 | `ABS / UPPER / LOWER / TRIM / LENGTH / ROUND / COALESCE / NULLIF` |
| 类型 | `INTEGER`、`REAL`、`TEXT`、`BOOLEAN`（写入时按列做类型亲和转换） |
| NULL | 完整三值逻辑（UNKNOWN）；`NULL` 比较/算术传播；`UNIQUE` 列允许多个 NULL |
| 事务 | `BEGIN` / `COMMIT` / `ROLLBACK`，**单写多读**（写事务互斥、读事务并发），提交时读集校验检测写冲突并回滚 |
| 其他 | 多语句（`;` 分隔）、`--` 行注释、`/* */` 块注释、错误带行列号、无 FROM 的常量 SELECT |

不支持（按需求刻意限制）：RIGHT/FULL JOIN、嵌套聚合、UNION、外键、触发器、视图。

## 执行计划

`EXPLAIN SELECT ...`（或界面「执行计划」按钮）输出算子树，包含：

- `TABLE_SCAN` / `INDEX_SCAN`（标注具体索引名与列，能直观看出是否走索引）
- `FILTER`（选择/连接条件过滤）、`PROJECT`（投影）
- `INNER_JOIN` / `LEFT_JOIN`（嵌套循环连接）、`DERIVED_SCAN`（派生表）
- `HASH_AGGREGATE`（GROUP BY / 聚合 + HAVING）、`SORT`（ORDER BY）
- `DISTINCT`（哈希去重）、`LIMIT_OFFSET`
- 每个节点带 **actualRows（实际产出行数）**

### 简单规则优化

1. **谓词拆分与选择下推**：`WHERE` 中的 `AND` 合取项拆分，只引用单表的谓词下推到该基表扫描之上；
   `LEFT JOIN` 右表上的谓词不下推（保留补 NULL 语义）。
2. **索引选择**：等值谓词按「主键 > 唯一索引 > 普通单列索引」选择；无可用索引时全表扫描。
3. **HAVING 下推到聚合算子**内部过滤；`LIMIT/OFFSET` 位于计划顶端提前截断。

## 架构

```
src/
├─ sql/
│  ├─ lexer.ts        词法分析（Token + 行列号 + 注释/字符串/引号标识符）
│  ├─ ast.ts          AST 节点
│  ├─ parser.ts       递归下降语法分析（表达式用优先级爬升）
│  └─ types.ts        值/表结构/结果/错误类型
├─ engine/
│  ├─ value.ts        类型转换、SQL 比较、三值逻辑、LIKE、算术
│  ├─ functions.ts    标量函数
│  ├─ storage.ts      存储接口 + 事务上下文/读集/扫描接口
│  ├─ memory-storage.ts  内存存储（测试用；快照覆盖 + 读集校验）
│  ├─ idb-storage.ts  IndexedDB 存储（固定三仓库 + 简单 WAL 崩溃恢复）
│  ├─ executor.ts     绑定器、BoundExpr、火山模型算子（next()）、求值器
│  ├─ planner.ts      逻辑计划→物理计划、规则优化（谓词下推/索引选择/聚合）
│  ├─ session.ts      SQL 会话：事务管理、DDL/DML/SELECT 执行
│  └─ import-export.ts JSON / SQL 脚本 / CSV 导入导出
├─ worker.ts          Web Worker 入口（全部执行不阻塞主线程）
├─ worker-client.ts   主线程 Promise 化客户端
├─ protocol.ts        线程间消息协议
└─ ui/                原生 DOM + CSS 界面（编辑器/结果/消息/计划/表结构/导入导出）
```

### 执行模型（火山模型）

每个物理算子实现 `next(ctx): Promise<Row|null>`，逐行向上拉取：

```
LIMIT_OFFSET → SORT → DISTINCT → PROJECT → HASH_AGGREGATE
      → FILTER → NESTED_LOOP_JOIN → TABLE_SCAN/INDEX_SCAN
```

表达式先由 `Binder` 把 AST 绑定为 `BoundExpr`（解析列到具体表别名、聚合调用登记为 `aggRef`、
子查询生成可按外层作用域重建的计划闭包），执行期 `evalExpr` 为 **async**，因此关联子查询
（EXISTS / IN / 标量）可以在每行求值时按需构建并拉取子计划。

### 存储与事务

- `Storage` 接口统一 `MemoryStorage`（测试）与 `IdbStorage`（浏览器）。
- 写事务：单写锁互斥；事务内变更先落在私有 pending 覆盖层，对本事务后续读立即可见，
  失败/回滚不落盘；提交时做读集版本校验（乐观并发），冲突整体回滚。
- 读事务：多读者不阻塞，只读快照。
- IndexedDB 实现用固定 schema 的三个对象仓库（行 / 目录 / WAL），
  写事务先写 `committed=false` 的 WAL 记录与带 `__txn` 标记的数据，再原子置 `committed=true`；
  重新打开库时清理未提交残留（简单崩溃恢复）。

## 测试

```
test/
├─ smoke.test.ts            增删改查基础链路
├─ joins-agg.test.ts        INNER/LEFT JOIN、聚合、GROUP BY/HAVING、DISTINCT、ORDER BY
├─ expr-null.test.ts        三值逻辑、表达式、LIKE、CASE、CAST、类型亲和
├─ subquery-txn.test.ts     IN/EXISTS/标量子查询、派生表、事务、约束与语法错误
├─ plan-io-edge.test.ts     执行计划/索引选择、JSON/CSV/SQL 往返、边界
├─ idb-storage.test.ts      IndexedDB 存储（fake-indexeddb）持久化与事务
├─ worker-protocol.test.ts  Worker 消息协议端到端
└─ concurrency.test.ts      单写多读、冲突回滚、事务可见性
```

共 **100+ 个用例**，覆盖增删改查、JOIN、聚合、子查询、NULL 三值逻辑、类型转换、
事务冲突、导入导出、执行计划与各类错误/边界。

## 数据导入导出

- **JSON**：整库导出 `{format, version, tables:[{definition, rows}]}`，可原样导回；
- **SQL 脚本**：`CREATE TABLE` + `CREATE [UNIQUE] INDEX` + 逐行 `INSERT`；
- **CSV**：单表导出（RFC 风格引号/转义、CRLF）；导入时可「新建表」（首列 `id` 自动识别为 INTEGER 主键，其余为 TEXT）或「写入已有表」（按列类型转换，空串为 NULL）。
