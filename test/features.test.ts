// 索引 / 事务 / 边界 / 错误
import { describe, it, expect } from './harness';
import { newEngine, column, rows, expectSqlError } from './helpers';
import { exportDatabaseJSON, importDatabaseJSON, rowsToCSV, parseCSV, importCSVIntoTable } from '../src/engine/import-export';

describe('索引', () => {
  it('91. 普通索引可创建且查询结果一致', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await e.execute('INSERT INTO t VALUES (1,10),(2,20),(3,20)');
    await e.execute('CREATE INDEX idx_v ON t(v)');
    expect(await column(e, 'SELECT id FROM t WHERE v = 20 ORDER BY id')).toEqual([2, 3]);
  });

  it('92. 唯一索引拒绝重复值', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT)');
    await e.execute("INSERT INTO t VALUES (1,'a@x')");
    await e.execute('CREATE UNIQUE INDEX uq_email ON t(email)');
    await expectSqlError(e, "INSERT INTO t VALUES (2,'a@x')", /UNIQUE/);
  });

  it('93. 在已有重复数据上建唯一索引失败并回滚', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT)');
    await e.execute("INSERT INTO t VALUES (1,'a'),(2,'a')");
    await expectSqlError(e, 'CREATE UNIQUE INDEX uq ON t(email)', /UNIQUE/);
    // 索引未建立：之后仍可插入重复
    await e.execute("INSERT INTO t VALUES (3,'a')");
    expect(await column(e, 'SELECT COUNT(*) FROM t')).toEqual([3]);
  });

  it('94. 唯一索引允许多个 NULL', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT)');
    await e.execute('CREATE UNIQUE INDEX uq ON t(email)');
    await e.execute('INSERT INTO t VALUES (1,NULL),(2,NULL)');
    expect(await column(e, 'SELECT COUNT(*) FROM t')).toEqual([2]);
  });

  it('95. DROP INDEX 后索引不再存在', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await e.execute('CREATE INDEX idx ON t(v)');
    await e.execute('DROP INDEX idx');
    await expectSqlError(e, 'DROP INDEX idx', /no such index/);
  });

  it('96. EXPLAIN 显示主键索引访问', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await e.execute('INSERT INTO t VALUES (1,10)');
    const r = (await e.execute('EXPLAIN SELECT * FROM t WHERE id = 1'))[0];
    expect(r.plan!.physical).toContain('IndexScan');
    expect(r.plan!.physical).toContain('PRIMARY(id)');
  });

  it('97. EXPLAIN 无索引时显示 SeqScan + Filter', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    const r = (await e.execute('EXPLAIN SELECT * FROM t WHERE v = 1'))[0];
    expect(r.plan!.physical).toContain('SeqScan');
    expect(r.plan!.physical).toContain('Filter');
  });

  it('98. 等值 JOIN 走 HashJoin', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE a (id INTEGER PRIMARY KEY, x INTEGER)');
    await e.execute('CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER)');
    const r = (await e.execute('EXPLAIN SELECT * FROM a JOIN b ON a.id = b.a_id'))[0];
    expect(r.plan!.physical).toContain('HashJoin');
  });
});

describe('事务', () => {
  it('99. COMMIT 持久化数据', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await e.execute('BEGIN');
    await e.execute('INSERT INTO t VALUES (1),(2)');
    await e.execute('COMMIT');
    expect(await column(e, 'SELECT COUNT(*) FROM t')).toEqual([2]);
  });

  it('100. ROLLBACK 撤销插入', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await e.execute('INSERT INTO t VALUES (1)');
    await e.execute('BEGIN');
    await e.execute('INSERT INTO t VALUES (2),(3)');
    await e.execute('ROLLBACK');
    expect(await column(e, 'SELECT id FROM t ORDER BY id')).toEqual([1]);
  });

  it('101. ROLLBACK 撤销更新与删除', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await e.execute('INSERT INTO t VALUES (1,10),(2,20)');
    await e.execute('BEGIN');
    await e.execute('UPDATE t SET v = 0');
    await e.execute('DELETE FROM t WHERE id = 1');
    await e.execute('ROLLBACK');
    expect(await rows(e, 'SELECT id, v FROM t ORDER BY id'))
      .toEqual([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
  });

  it('102. 语句错误后事务进入 aborted 状态，ROLLBACK 恢复', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await e.execute('BEGIN');
    await e.execute('INSERT INTO t VALUES (1)');
    await expectSqlError(e, 'INSERT INTO t VALUES (1)', /UNIQUE/);
    await expectSqlError(e, 'SELECT * FROM t', /aborted/);
    await e.execute('ROLLBACK');
    expect(await column(e, 'SELECT COUNT(*) FROM t')).toEqual([0]);
  });

  it('103. 事务内 DDL 也可回滚', async () => {
    const e = await newEngine();
    await e.execute('BEGIN');
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await e.execute('INSERT INTO t VALUES (1)');
    await e.execute('ROLLBACK');
    await expectSqlError(e, 'SELECT * FROM t', /no such table/);
  });

  it('104. 未开启事务时 COMMIT/ROLLBACK 报错', async () => {
    const e = await newEngine();
    await expectSqlError(e, 'COMMIT', /no transaction/);
    await expectSqlError(e, 'ROLLBACK', /no transaction/);
  });

  it('105. 嵌套 BEGIN 报错', async () => {
    const e = await newEngine();
    await e.execute('BEGIN');
    await expectSqlError(e, 'BEGIN', /already an active transaction/);
    await e.execute('ROLLBACK');
  });
});

describe('边界条件', () => {
  it('106. LIMIT 0 返回空', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await e.execute('INSERT INTO t VALUES (1),(2)');
    expect(await column(e, 'SELECT * FROM t LIMIT 0')).toEqual([]);
  });

  it('107. OFFSET 超出范围返回空', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await e.execute('INSERT INTO t VALUES (1)');
    expect(await column(e, 'SELECT * FROM t OFFSET 5')).toEqual([]);
  });

  it('108. 大整数与负数', async () => {
    const e = await newEngine();
    expect(await column(e, 'SELECT 9007199254740991 AS z', 'z')).toEqual([9007199254740991]);
    expect(await column(e, 'SELECT -5 + 3 AS z', 'z')).toEqual([-2]);
  });

  it('109. 空字符串与特殊字符（单引号转义）', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (s TEXT)');
    await e.execute("INSERT INTO t VALUES (''),('a,b'),('line\nbreak'),('quote''s')");
    expect(await column(e, 'SELECT COUNT(*) FROM t')).toEqual([4]);
    expect(await column(e, "SELECT s FROM t WHERE s = ''")).toEqual(['']);
    expect(await column(e, "SELECT s FROM t WHERE s = 'quote''s'")).toEqual(["quote's"]);
  });

  it('110. 全 NULL 表上的全局聚合', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (v INTEGER)');
    await e.execute('INSERT INTO t VALUES (NULL),(NULL)');
    const r = await rows(e, 'SELECT COUNT(*) c, SUM(v) s, AVG(v) a FROM t');
    expect(r).toEqual([{ c: 2, s: null, a: null }]);
  });

  it('111. 无 FROM 的常量 SELECT', async () => {
    const e = await newEngine();
    const r = await rows(e, 'SELECT 1 AS a, 1 + 1 AS b');
    expect(r).toEqual([{ a: 1, b: 2 }]);
  });

  it('112. 空输入字符串返回空结果集', async () => {
    const e = await newEngine();
    expect(await e.execute('   ')).toEqual([]);
    expect(await e.execute('-- just a comment')).toEqual([]);
  });

  it('113. 多条语句一次执行', async () => {
    const e = await newEngine();
    const rs = await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1); SELECT * FROM t;');
    expect(rs).toHaveLength(3);
    expect(rs[2].rows).toEqual([{ id: 1 }]);
  });

  it('114. 注释（-- 与 /* */）不影响解析', async () => {
    const e = await newEngine();
    const r = await rows(e, `
      -- 行注释
      SELECT /* 块注释 */ 1 AS a,
             1 + /* 内嵌 */ 1 AS b
    `);
    expect(r[0]).toEqual({ a: 1, b: 2 });
  });

  it('115. 引号标识符作为关键字列名', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t ("order" INTEGER PRIMARY KEY, "select" TEXT)');
    await e.execute(`INSERT INTO t VALUES (1, 'x')`);
    expect(await column(e, `SELECT "select" FROM t`)).toEqual(['x']);
  });
});

describe('错误处理与行列号', () => {
  it('116. 语法错误指向行列号', async () => {
    const e = await newEngine();
    const err = await expectSqlError(e, 'SELECT FROM', undefined);
    expect(err.kind).toBe('SYNTAX');
    expect(err.line).toBe(1);
    expect(err.column).toBe(8);
  });

  it('117. 第二行的错误行号为 2', async () => {
    const e = await newEngine();
    const err = await expectSqlError(e, 'SELECT 1;\nSELEC 1', undefined);
    expect(err.line).toBe(2);
  });

  it('118. 未知表/列错误类型为 BIND', async () => {
    const e = await newEngine();
    const err1 = await expectSqlError(e, 'SELECT * FROM ghost');
    expect(err1.kind).toBe('BIND');
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const err2 = await expectSqlError(e, 'SELECT nope FROM t');
    expect(err2.kind).toBe('BIND');
  });

  it('119. 缺少右括号报错', async () => {
    const e = await newEngine();
    await expectSqlError(e, 'SELECT (1 + 2', /expected/);
  });

  it('120. 未知函数报错', async () => {
    const e = await newEngine();
    await expectSqlError(e, 'SELECT foobar(1)', /unknown function/);
  });

  it('121. GROUP BY 位置越界报错', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (a INTEGER)');
    await expectSqlError(e, 'SELECT a FROM t ORDER BY 5', /out of range/);
  });
});

describe('导入导出', () => {
  it('122. 导出/导入整库 JSON 保持数据', async () => {
    const e1 = await newEngine();
    await e1.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await e1.execute("INSERT INTO t VALUES (1,'Alice'),(2,NULL)");
    const json = exportDatabaseJSON(e1.db);

    const e2 = await newEngine();
    const info = await importDatabaseJSON(e2, json);
    expect(info.tables).toBe(1);
    expect(info.rows).toBe(2);
    expect(await rows(e2, 'SELECT id, name FROM t ORDER BY id'))
      .toEqual([{ id: 1, name: 'Alice' }, { id: 2, name: null }]);
  });

  it('123. 导出 CSV 往返', async () => {
    const csv = rowsToCSV(
      [{ a: 1, b: 'x,y' }, { a: 2, b: null }],
      ['a', 'b'],
    );
    expect(csv).toContain('"x,y"');
    const parsed = parseCSV(csv);
    expect(parsed.columns).toEqual(['a', 'b']);
    expect(parsed.rows[0]).toEqual({ a: '1', b: 'x,y' });
    expect(parsed.rows[1]).toEqual({ a: '2', b: null }); // 空字段 => null
  });

  it('124. CSV 导入到已有表并做类型转换', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, active BOOLEAN)');
    const csv = 'id,name,active\n1,Alice,true\n2,Bob,false\n';
    const n = await importCSVIntoTable(e, 't', csv);
    expect(n).toBe(2);
    expect(await rows(e, 'SELECT id, name, active FROM t ORDER BY id'))
      .toEqual([
        { id: 1, name: 'Alice', active: true },
        { id: 2, name: 'Bob', active: false },
      ]);
  });

  it('125. 导入损坏 JSON 报错', async () => {
    const e = await newEngine();
    const { importDatabaseJSON: imp } = await import('../src/engine/import-export');
    let threw = false;
    try { await imp(e, '{not json'); } catch { threw = true; }
    expect(threw).toBeTruthy();
  });
});
