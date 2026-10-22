# 数据库初始化 SQL

这个目录**必须随仓库分发**。新机器克隆项目后，`一键启动.bat` 会自动读取这里的文件把数据库建好。
（这些文件已经过处理：不含真实业务数据、不含 MySQL 8 专属语法。）

## 文件说明

| 文件 | 导入到哪个库 | 内容 | 导入时机 |
|---|---|---|---|
| `uni-tables.sql` | `sms_common` | **43 张统一表**（`t_uni_*`）的建表语句 | `npm run migrate` 之后 |
| `sms_portal.sql` | `sms_portal` | 统一门户：账号表 + 16 个演示账号 | 该库为空时 |
| `sms_perm.sql` | `sms_perm` | 权限管理：部门/角色/用户/页面/菜单/规则 | 该库为空时 |
| `sms_consult.sql` | `sms_consult` | 市场咨询：学员、缴费、退费、消费明细 | 该库为空时 |
| `sms_finance.sql` | `sms_finance` | 财务管理：账单、费用、冻结、退费 | 该库为空时 |
| `legacy-teaching.sql` | `sms_class` / `sms_class_jh` / `sms_job` / `sms_common(仅 4 张 *_sync)` | **教学域历史表结构**（75 张，纯 DDL、无数据）。P8 之后这些表已 DROP，**只有演示数据脚本需要**：`seed-all-demo` / `seed-demo` / `reset-demo-data` 会临时建表 → 按老列写 → 同步进 `t_uni_*` → 再删掉 | **不要**在正常部署时导入；由 `scripts/_uni-recreate-legacy.mjs` 按需临时创建 |

## 为什么需要这些文件

系统一共 9 个库，但它们的建表方式**不统一**：

| 建表方式 | 覆盖的库 | 说明 |
|---|---|---|
| `npm run migrate`（knex 迁移） | `sms_job` `sms_edu` `sms_class` `sms_class_jh` `sms_common`（部分表） | 后端的 5 个迁移目录 |
| **本目录的 SQL** | `sms_portal` `sms_consult` `sms_finance` `sms_perm` + `sms_common` 的统一表 | 迁移管不到的部分 |

也就是说：**只跑 `npm run migrate` 是不够的**——四个模块库和 43 张统一表都不在迁移范围内。
少了它们，登录会报「数据表不存在」，各业务页面也会缺表。

## 两个必须注意的点

### 1. `sms_portal` / `sms_perm` / `sms_consult` / `sms_finance` 这四个文件含 `DROP TABLE`

它们是数据库导出文件，开头有 `DROP TABLE IF EXISTS`。所以：

- ⚠️ **只对空库导入**。库里已有业务表时导入会冲掉数据。
- 启动器已经做了保护（先查表数量，库里有表就跳过），但**手动导入时请自己确认**。

### 2. `uni-tables.sql` 是安全可重复执行的

它是 `CREATE TABLE IF NOT EXISTS`，**不含 DROP、不含 INSERT**：

- 库里有这张表 → 跳过，不动数据
- 库里没有 → 建出来
- 跑多少遍都安全

所以它可以在每次启动时都跑一遍，用来补上缺失的统一表。

## 演示数据说明

这四个 SQL 里的数据都是**演示数据**（学员姓名如「王伟」「李芳」、手机号如 `13810026001` 连号、
`t_student_base.remark` 字段直接标了「演示数据」）。

**门户演示账号 16 个，密码统一 `123456`**（`t_sys_account.password` 存的是**明文**）。

> 正式部署前必须：① 改掉所有演示账号密码；② 把密码字段改成哈希存储；
> ③ 替换掉演示业务数据。**不要把演示环境直接当生产用。**

## 手动导入（不用启动器时）

```bash
# 在 server-job 目录下，先建表
npm run migrate

# 再依次导入（按依赖顺序）
mysql -uroot -p sms_common   < sql/init/uni-tables.sql
mysql -uroot -p sms_portal   < sql/init/sms_portal.sql
mysql -uroot -p sms_perm     < sql/init/sms_perm.sql
mysql -uroot -p sms_consult  < sql/init/sms_consult.sql
mysql -uroot -p sms_finance  < sql/init/sms_finance.sql
```

## 怎么更新这些文件

数据模型变了之后，请**从权威库重新导出**，不要手改：

```bash
# 统一表（43 张，自动加 IF NOT EXISTS）
node scripts/_export-uni-ddl.cjs

# 四个模块库（用 mysqldump，注意导出后把 utf8mb4_0900_ai_ci 换成 utf8mb4_unicode_ci）
mysqldump -uroot -p --databases sms_portal > sql/init/sms_portal.sql
```

> ⚠️ **必须清掉 `utf8mb4_0900_ai_ci`**。那是 MySQL 8.0 专属的排序规则，
> MariaDB（本项目的运行环境）完全不认，带它建表会直接报
> `Unknown collation: 'utf8mb4_0900_ai_ci'`。
> 启动器导入时会自动替换一次，但**放进仓库前就该改干净**：
>
> ```bash
> sed -i 's/utf8mb4_0900_ai_ci/utf8mb4_unicode_ci/g' sql/init/*.sql
> ```
