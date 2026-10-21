-- MySQL dump 10.13  Distrib 8.4.9, for Win64 (x86_64)
--
-- Host: localhost    Database: sms_consult
-- ------------------------------------------------------
-- Server version	8.4.9

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Current Database: `sms_consult`
--

CREATE DATABASE /*!32312 IF NOT EXISTS*/ `sms_consult` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci */ /*!80016 DEFAULT ENCRYPTION='N' */;

USE `sms_consult`;

--
-- Table structure for table `knex_migrations`
--

DROP TABLE IF EXISTS `knex_migrations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `knex_migrations` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(255) DEFAULT NULL,
  `batch` int DEFAULT NULL,
  `migration_time` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `knex_migrations`
--

LOCK TABLES `knex_migrations` WRITE;
/*!40000 ALTER TABLE `knex_migrations` DISABLE KEYS */;
INSERT INTO `knex_migrations` VALUES (1,'20261002_001_create_consult_student.js',1,'2026-10-02 08:41:27'),(2,'20261002_002_create_consult_fee_order.js',1,'2026-10-02 08:41:27'),(3,'20261002_003_create_consult_refund.js',1,'2026-10-02 08:41:28'),(4,'20261002_004_create_consult_aux_tables.js',1,'2026-10-02 08:41:28'),(5,'20261002_005_seed_consult_data.js',1,'2026-10-02 08:41:28'),(6,'20261002_006_alter_fee_order_batch_no.js',2,'2026-10-02 08:53:23'),(7,'20261002_007_fix_state_offset_and_not_enrolled.js',3,'2026-10-02 10:08:21'),(8,'20261002_008_remove_finance_role.js',4,'2026-10-02 12:19:29');
/*!40000 ALTER TABLE `knex_migrations` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `knex_migrations_lock`
--

DROP TABLE IF EXISTS `knex_migrations_lock`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `knex_migrations_lock` (
  `index` int unsigned NOT NULL AUTO_INCREMENT,
  `is_locked` int DEFAULT NULL,
  PRIMARY KEY (`index`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `knex_migrations_lock`
--

LOCK TABLES `knex_migrations_lock` WRITE;
/*!40000 ALTER TABLE `knex_migrations_lock` DISABLE KEYS */;
INSERT INTO `knex_migrations_lock` VALUES (1,0);
/*!40000 ALTER TABLE `knex_migrations_lock` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `t_consult_account`
--

DROP TABLE IF EXISTS `t_consult_account`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `t_consult_account` (
  `id` varchar(36) NOT NULL COMMENT '主键UUID',
  `create_time` datetime NOT NULL COMMENT '创建时间',
  `create_by` varchar(36) DEFAULT NULL COMMENT '创建人ID',
  `create_by_name` varchar(50) DEFAULT NULL COMMENT '创建人姓名',
  `update_time` datetime DEFAULT NULL COMMENT '修改时间',
  `update_by` varchar(36) DEFAULT NULL COMMENT '修改人ID',
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0' COMMENT '逻辑删除',
  `account` varchar(50) NOT NULL COMMENT '登录账号',
  `password` varchar(100) NOT NULL COMMENT '密码（演示环境明文）',
  `user_name` varchar(50) NOT NULL COMMENT '姓名',
  `role` varchar(20) NOT NULL COMMENT '岗位代码 admin/manager/consult/finance',
  `role_title` varchar(50) DEFAULT NULL COMMENT '岗位名称（快照）',
  `dept` varchar(50) DEFAULT NULL COMMENT '所属部门',
  `phone` varchar(20) DEFAULT NULL COMMENT '联系电话',
  `active` tinyint(1) NOT NULL DEFAULT '1' COMMENT '是否启用',
  `last_login` datetime DEFAULT NULL COMMENT '最近登录时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_ca_account` (`account`),
  KEY `idx_ca_role` (`role`),
  KEY `idx_ca_active` (`active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='咨询模块账号表';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `t_consult_account`
--

LOCK TABLES `t_consult_account` WRITE;
/*!40000 ALTER TABLE `t_consult_account` DISABLE KEYS */;
INSERT INTO `t_consult_account` VALUES ('1b6c0d9d-f07f-4808-9b75-0763f68690ff','2026-10-06 21:25:29','SEED','SEED','2026-10-06 21:25:29','SEED',0,'wangjl','123456','王经理','manager','咨询经理','市场咨询部','13700000002',1,NULL),('278d7a01-b3bc-45e1-84aa-154d02734351','2026-10-06 21:25:29','SEED','SEED','2026-10-06 21:25:29','SEED',0,'zhangls','123456','张老师','consult','咨询师','市场咨询部','13700000003',1,NULL),('a964420e-2f15-4eea-a565-75b58a0eb626','2026-10-06 21:25:29','SEED','SEED','2026-10-06 21:25:29','SEED',0,'lilx','123456','李老师','consult','咨询师','市场咨询部','13700000004',1,NULL),('cf9463d2-c420-417e-9d7f-7f56e472abf8','2026-10-06 21:25:29','SEED','SEED','2026-10-06 21:25:29','SEED',0,'admin','123456','系统管理员','admin','系统管理员','信息中心','13700000001',1,NULL);
/*!40000 ALTER TABLE `t_consult_account` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `t_consult_config`
--

DROP TABLE IF EXISTS `t_consult_config`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `t_consult_config` (
  `id` varchar(36) NOT NULL COMMENT '主键UUID',
  `create_time` datetime NOT NULL COMMENT '创建时间',
  `create_by` varchar(36) DEFAULT NULL COMMENT '创建人ID',
  `update_time` datetime DEFAULT NULL COMMENT '修改时间',
  `update_by` varchar(36) DEFAULT NULL COMMENT '修改人ID',
  `config_key` varchar(64) NOT NULL COMMENT '配置键',
  `config_value` varchar(200) NOT NULL COMMENT '配置值（统一存字符串，用时转）',
  `remark` varchar(200) DEFAULT NULL COMMENT '配置说明',
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0' COMMENT '逻辑删除',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_cc_key` (`config_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='咨询模块配置表';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `t_consult_config`
--

LOCK TABLES `t_consult_config` WRITE;
/*!40000 ALTER TABLE `t_consult_config` DISABLE KEYS */;
INSERT INTO `t_consult_config` VALUES ('CCFG-1','2026-10-06 21:25:29','SEED','2026-10-06 21:25:29','SEED','trialDays','7','试学默认天数',0),('CCFG-2','2026-10-06 21:25:29','SEED','2026-10-06 21:25:29','SEED','lossReasons','已选其他机构,距离太远,费用太高','流失原因候选',0);
/*!40000 ALTER TABLE `t_consult_config` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `t_consult_consume_item`
--

DROP TABLE IF EXISTS `t_consult_consume_item`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `t_consult_consume_item` (
  `id` varchar(36) NOT NULL COMMENT '主键UUID',
  `create_time` datetime NOT NULL COMMENT '创建时间',
  `create_by` varchar(36) DEFAULT NULL COMMENT '创建人ID',
  `update_time` datetime DEFAULT NULL COMMENT '修改时间',
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0' COMMENT '逻辑删除',
  `item_name` varchar(50) NOT NULL COMMENT '物品名称',
  `price` int NOT NULL DEFAULT '0' COMMENT '单价（单位：分）',
  `sort_no` int DEFAULT '0' COMMENT '排序号',
  `is_enabled` tinyint(1) NOT NULL DEFAULT '1' COMMENT '是否启用',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_cci_name` (`item_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='试学物品领用字典表';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `t_consult_consume_item`
--

LOCK TABLES `t_consult_consume_item` WRITE;
/*!40000 ALTER TABLE `t_consult_consume_item` DISABLE KEYS */;
INSERT INTO `t_consult_consume_item` VALUES ('CIT-1','2026-10-06 21:25:29','SEED','2026-10-06 21:25:29',0,'校服',12000,1,1),('CIT-2','2026-10-06 21:25:29','SEED','2026-10-06 21:25:29',0,'被褥三件套',15000,2,1),('CIT-4','2026-10-06 21:25:29','SEED','2026-10-06 21:25:29',0,'教材资料',6000,4,1),('CIT-5','2026-10-06 21:25:29','SEED','2026-10-06 21:25:29',0,'军训服',9000,5,1);
/*!40000 ALTER TABLE `t_consult_consume_item` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `t_consult_fee_order`
--

DROP TABLE IF EXISTS `t_consult_fee_order`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `t_consult_fee_order` (
  `id` varchar(36) NOT NULL COMMENT '主键UUID',
  `create_time` datetime NOT NULL COMMENT '创建时间',
  `create_by` varchar(36) DEFAULT NULL COMMENT '创建人ID',
  `create_by_name` varchar(50) DEFAULT NULL COMMENT '创建人姓名（快照）',
  `update_time` datetime DEFAULT NULL COMMENT '修改时间',
  `update_by` varchar(36) DEFAULT NULL COMMENT '修改人ID',
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0' COMMENT '逻辑删除',
  `order_no` varchar(32) NOT NULL COMMENT '本模块单号，如 SK20261002-001',
  `finance_fee_id` varchar(36) DEFAULT NULL COMMENT '财务侧缴费单 id（建单成功后回填）',
  `consult_student_id` varchar(36) NOT NULL COMMENT '学生id',
  `student_name` varchar(50) DEFAULT NULL COMMENT '学生姓名快照',
  `student_no` varchar(32) DEFAULT NULL COMMENT '学号快照',
  `class_name` varchar(50) DEFAULT NULL COMMENT '班级快照',
  `dept_code` int DEFAULT NULL COMMENT '部门（取费用标准用）',
  `fee_type` int NOT NULL COMMENT '费用类型 1学费2住宿费3餐费4保险费5试学费',
  `amount` int NOT NULL DEFAULT '0' COMMENT '金额（单位：分）',
  `status` int NOT NULL DEFAULT '0' COMMENT '咨询侧状态 0待上传凭证 1待确认 2已到账 3已驳回',
  `finance_pay_status` int DEFAULT NULL COMMENT '财务侧 payStatus 快照',
  `reject_reason` varchar(200) DEFAULT NULL COMMENT '财务打回原因',
  `voucher_url` varchar(500) DEFAULT NULL COMMENT '缴费截图 URL（相对路径）',
  `voucher_no` varchar(100) DEFAULT NULL COMMENT '转账单号 / 流水号',
  `voucher_by` varchar(50) DEFAULT NULL COMMENT '上传凭证的人',
  `pay_method` varchar(20) DEFAULT NULL COMMENT '缴费方式 微信/支付宝/现金/银行转账/对公汇款',
  `batch_no` bigint DEFAULT NULL COMMENT '同一次发起的批次号（转正式 4 笔同批）',
  `plan_id` varchar(36) DEFAULT NULL COMMENT '★ 2026-10-16 分期：所属分期计划ID（一次性缴费为 NULL）',
  `stage_no` int DEFAULT NULL COMMENT '★ 2026-10-16 分期：第几期，从 1 开始（一次性缴费为 NULL）',
  `total_due_amount` int DEFAULT NULL COMMENT '★ 2026-10-16 分期：整单应收（分）；一次性缴费为 NULL',
  `item_detail` text COMMENT '★ 2026-10-15 合并缴费的明细（JSON 数组：[{feeType,feeTypeName,amount}]）。一次缴清多项时只建一张合计单，勾选了哪些费用存在这里，单笔缴费为 NULL',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_cfo_order_no` (`order_no`),
  KEY `idx_cfo_student` (`consult_student_id`),
  KEY `idx_cfo_finance_fee` (`finance_fee_id`),
  KEY `idx_cfo_status` (`status`),
  KEY `idx_cfo_fee_type` (`fee_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='咨询收款单表（与财务模块联动）';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `t_consult_fee_order`
--

LOCK TABLES `t_consult_fee_order` WRITE;
/*!40000 ALTER TABLE `t_consult_fee_order` DISABLE KEYS */;
INSERT INTO `t_consult_fee_order` VALUES ('ORD-001','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'SK20260001','FEE-ZX26001-5','CST-ZX26001','唐俊杰','ZX26001',NULL,1,5,98000,0,1,NULL,NULL,NULL,NULL,'wechat',1),('ORD-002','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'SK20260002','FEE-ZX26002-5','CST-ZX26002','苏雅雯','ZX26002',NULL,1,5,98000,1,2,NULL,'/uploads/seed/voucher-ZX26002.png','QPZZX26002','李老师','wechat',2),('ORD-003','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'SK20260003','FEE-ZX26003-5','CST-ZX26003','谢铭轩','ZX26003',NULL,1,5,98000,0,1,NULL,NULL,NULL,NULL,'wechat',3),('ORD-004','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'SK20260004','FEE-ZX26004-5','CST-ZX26004','郭子睿','ZX26004',NULL,1,5,98000,0,1,NULL,NULL,NULL,NULL,'wechat',4),('ORD-005','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'SK20260005','FEE-U26006-1','CST-U26006','杨静怡','U26006','U2602',2,1,1580000,2,3,NULL,'/uploads/seed/voucher-U26006.png','QPZU26006','张老师','wechat',5),('ORD-006','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'SK20260006','FEE-U26007-1','CST-U26007','赵一鸣','U26007','U2602',2,1,1580000,2,3,NULL,'/uploads/seed/voucher-U26007.png','QPZU26007','张老师','wechat',6),('ORD-007','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'SK20260007','FEE-U26008-1','CST-U26008','孙浩然','U26008','U2602',2,1,1580000,2,3,NULL,'/uploads/seed/voucher-U26008.png','QPZU26008','李老师','wechat',7),('ORD-008','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'SK20260008','FEE-U26009-1','CST-U26009','周晓彤','U26009','U2602',2,1,1580000,2,3,NULL,'/uploads/seed/voucher-U26009.png','QPZU26009','李老师','wechat',8),('ORD-009','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'SK20260009','FEE-U26010-1','CST-U26010','吴子豪','U26010','U2602',2,1,1580000,2,3,NULL,'/uploads/seed/voucher-U26010.png','QPZU26010','王经理','wechat',9),('ORD-010','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'SK20260010','FEE-U26016-1','CST-U26016','马志远','U26016',NULL,2,1,1580000,2,3,NULL,'/uploads/seed/voucher-U26016.png','QPZU26016','张老师','wechat',10),('ORD-011','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'SK20260011','FEE-U26017-1','CST-U26017','何静宜','U26017',NULL,2,1,1580000,2,3,NULL,'/uploads/seed/voucher-U26017.png','QPZU26017','李老师','wechat',11),('ORD-012','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'SK20260012','FEE-U26018-1','CST-U26018','高远航','U26018',NULL,2,1,1580000,2,3,NULL,'/uploads/seed/voucher-U26018.png','QPZU26018','王经理','wechat',12),('ORD-013','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'SK20260013','FEE-J26011-1','CST-J26011','邓雨欣','J26011','G2601',1,1,1280000,2,3,NULL,'/uploads/seed/voucher-J26011.png','QPZJ26011','张老师','wechat',13),('ORD-014','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'SK20260014','FEE-J26012-1','CST-J26012','罗佳怡','J26012','J2602',1,1,1280000,2,3,NULL,'/uploads/seed/voucher-J26012.png','QPZJ26012','李老师','wechat',14);
/*!40000 ALTER TABLE `t_consult_fee_order` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `t_consult_installment_plan`
-- ★ 2026-10-16 分期付款：一次发起收费 = 一张分期计划，下挂 N 个期次
--

DROP TABLE IF EXISTS `t_consult_installment_plan`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `t_consult_installment_plan` (
  `id` varchar(36) NOT NULL COMMENT '分期计划ID',
  `create_time` datetime NOT NULL COMMENT '创建时间',
  `create_by` varchar(36) DEFAULT NULL COMMENT '创建人ID',
  `create_by_name` varchar(50) DEFAULT NULL COMMENT '创建人姓名（快照）',
  `update_time` datetime DEFAULT NULL COMMENT '修改时间',
  `update_by` varchar(36) DEFAULT NULL COMMENT '修改人ID',
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0' COMMENT '逻辑删除',
  `plan_no` varchar(32) NOT NULL COMMENT '分期计划号 FP20261016-001',
  `consult_student_id` varchar(36) NOT NULL COMMENT '咨询学生ID',
  `student_name` varchar(50) DEFAULT NULL COMMENT '学生姓名快照',
  `student_no` varchar(32) DEFAULT NULL COMMENT '学号快照',
  `dept_code` int DEFAULT NULL COMMENT '部门',
  `total_amount` int NOT NULL DEFAULT '0' COMMENT '应收总额（分）',
  `paid_amount` int NOT NULL DEFAULT '0' COMMENT '已缴（分，到账才计入）',
  `discount_amount` int NOT NULL DEFAULT '0' COMMENT '整单优惠（分）',
  `pending_amount` int NOT NULL DEFAULT '0' COMMENT '待缴（分）= total - discount - paid',
  `stage_count` int NOT NULL DEFAULT '1' COMMENT '总期数',
  `paid_stages` int NOT NULL DEFAULT '0' COMMENT '已结清期数',
  `status` int NOT NULL DEFAULT '1' COMMENT '1进行中 2已完成 3已终止',
  `item_detail` text COMMENT '费用项明细快照 JSON',
  `remark` varchar(200) DEFAULT NULL COMMENT '备注',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_cip_plan_no` (`plan_no`),
  KEY `idx_cip_student` (`consult_student_id`),
  KEY `idx_cip_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='咨询分期计划表';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `t_consult_installment_plan`
--

LOCK TABLES `t_consult_installment_plan` WRITE;
/*!40000 ALTER TABLE `t_consult_installment_plan` DISABLE KEYS */;
/*!40000 ALTER TABLE `t_consult_installment_plan` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `t_consult_installment_item`
-- ★ 2026-10-16 分期付款：期次明细，每期一条，缴完一张缴费单就回写一条
--

DROP TABLE IF EXISTS `t_consult_installment_item`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `t_consult_installment_item` (
  `id` varchar(36) NOT NULL COMMENT '期次ID',
  `create_time` datetime NOT NULL COMMENT '创建时间',
  `update_time` datetime DEFAULT NULL COMMENT '修改时间',
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0' COMMENT '逻辑删除',
  `plan_id` varchar(36) NOT NULL COMMENT '分期计划ID',
  `stage_no` int NOT NULL COMMENT '第几期，从1开始',
  `due_amount` int NOT NULL DEFAULT '0' COMMENT '本期应收（分）',
  `due_date` date DEFAULT NULL COMMENT '到期日',
  `paid_amount` int NOT NULL DEFAULT '0' COMMENT '本期已缴（分）',
  `status` int NOT NULL DEFAULT '0' COMMENT '0待缴 1待确认 2已到账 3已顺延(历史)',
  `postpone_count` int NOT NULL DEFAULT '0' COMMENT '★ 2026-10-16 自动顺延次数：到期未缴每次自动后移一个周期并+1',
  `fee_order_id` varchar(36) DEFAULT NULL COMMENT '关联缴费单ID',
  `pay_time` datetime DEFAULT NULL COMMENT '到账时间',
  `remark` varchar(200) DEFAULT NULL COMMENT '备注',
  PRIMARY KEY (`id`),
  KEY `idx_cii_plan` (`plan_id`),
  KEY `idx_cii_order` (`fee_order_id`),
  KEY `idx_cii_due` (`due_date`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='咨询分期期次明细表';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `t_consult_installment_item`
--

LOCK TABLES `t_consult_installment_item` WRITE;
/*!40000 ALTER TABLE `t_consult_installment_item` DISABLE KEYS */;
/*!40000 ALTER TABLE `t_consult_installment_item` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `t_consult_history`
--

DROP TABLE IF EXISTS `t_consult_history`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `t_consult_history` (
  `id` varchar(36) NOT NULL COMMENT '主键UUID',
  `create_time` datetime NOT NULL COMMENT '创建时间（即操作时间）',
  `create_by` varchar(36) DEFAULT NULL COMMENT '操作人ID',
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0' COMMENT '逻辑删除',
  `consult_student_id` varchar(36) NOT NULL COMMENT '学生id',
  `by_name` varchar(50) DEFAULT NULL COMMENT '操作人姓名',
  `by_title` varchar(50) DEFAULT NULL COMMENT '操作人岗位',
  `action` varchar(50) DEFAULT NULL COMMENT '动作标识，如 ASSIGN/INTERVIEW_PASS/CHARGE/FREEZE',
  `text` varchar(500) DEFAULT NULL COMMENT '操作描述（直接展示给学生看的中文）',
  PRIMARY KEY (`id`),
  KEY `idx_ch_student_time` (`consult_student_id`,`create_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='咨询跟进历史表';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `t_consult_history`
--

LOCK TABLES `t_consult_history` WRITE;
/*!40000 ALTER TABLE `t_consult_history` DISABLE KEYS */;
INSERT INTO `t_consult_history` VALUES ('CH-1','2026-10-06 21:25:29','SEED',0,'CST-ZX26001','张老师','咨询师','create','创建学员档案'),('CH-10','2026-10-06 21:25:29','SEED',0,'CST-U26006','张老师','咨询师','follow','电话回访，家长意向明确'),('CH-11','2026-10-06 21:25:29','SEED',0,'CST-U26007','张老师','咨询师','create','创建学员档案'),('CH-12','2026-10-06 21:25:29','SEED',0,'CST-U26007','张老师','咨询师','follow','电话回访，家长意向明确'),('CH-13','2026-10-06 21:25:29','SEED',0,'CST-U26008','李老师','咨询师','create','创建学员档案'),('CH-14','2026-10-06 21:25:29','SEED',0,'CST-U26008','李老师','咨询师','follow','电话回访，家长意向明确'),('CH-15','2026-10-06 21:25:29','SEED',0,'CST-U26009','李老师','咨询师','create','创建学员档案'),('CH-16','2026-10-06 21:25:29','SEED',0,'CST-U26009','李老师','咨询师','follow','电话回访，家长意向明确'),('CH-17','2026-10-06 21:25:29','SEED',0,'CST-U26010','王经理','咨询经理','create','创建学员档案'),('CH-18','2026-10-06 21:25:29','SEED',0,'CST-U26010','王经理','咨询经理','follow','电话回访，家长意向明确'),('CH-19','2026-10-06 21:25:29','SEED',0,'CST-U26016','张老师','咨询师','create','创建学员档案'),('CH-2','2026-10-06 21:25:29','SEED',0,'CST-ZX26001','张老师','咨询师','follow','电话回访，家长意向明确'),('CH-20','2026-10-06 21:25:29','SEED',0,'CST-U26016','张老师','咨询师','follow','电话回访，家长意向明确'),('CH-21','2026-10-06 21:25:29','SEED',0,'CST-U26017','李老师','咨询师','create','创建学员档案'),('CH-22','2026-10-06 21:25:29','SEED',0,'CST-U26017','李老师','咨询师','follow','电话回访，家长意向明确'),('CH-23','2026-10-06 21:25:29','SEED',0,'CST-U26018','王经理','咨询经理','create','创建学员档案'),('CH-24','2026-10-06 21:25:29','SEED',0,'CST-U26018','王经理','咨询经理','follow','电话回访，家长意向明确'),('CH-25','2026-10-06 21:25:29','SEED',0,'CST-J26011','张老师','咨询师','create','创建学员档案'),('CH-26','2026-10-06 21:25:29','SEED',0,'CST-J26011','张老师','咨询师','follow','电话回访，家长意向明确'),('CH-27','2026-10-06 21:25:29','SEED',0,'CST-J26012','李老师','咨询师','create','创建学员档案'),('CH-28','2026-10-06 21:25:29','SEED',0,'CST-J26012','李老师','咨询师','follow','电话回访，家长意向明确'),('CH-3','2026-10-06 21:25:29','SEED',0,'CST-ZX26002','李老师','咨询师','create','创建学员档案'),('CH-4','2026-10-06 21:25:29','SEED',0,'CST-ZX26002','李老师','咨询师','follow','电话回访，家长意向明确'),('CH-5','2026-10-06 21:25:29','SEED',0,'CST-ZX26003','李老师','咨询师','create','创建学员档案'),('CH-6','2026-10-06 21:25:29','SEED',0,'CST-ZX26003','李老师','咨询师','follow','电话回访，家长意向明确'),('CH-7','2026-10-06 21:25:29','SEED',0,'CST-ZX26004','李老师','咨询师','create','创建学员档案'),('CH-8','2026-10-06 21:25:29','SEED',0,'CST-ZX26004','李老师','咨询师','follow','电话回访，家长意向明确'),('CH-9','2026-10-06 21:25:29','SEED',0,'CST-U26006','张老师','咨询师','create','创建学员档案');
/*!40000 ALTER TABLE `t_consult_history` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `t_consult_refund`
--

DROP TABLE IF EXISTS `t_consult_refund`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `t_consult_refund` (
  `id` varchar(36) NOT NULL COMMENT '主键UUID',
  `create_time` datetime NOT NULL COMMENT '创建时间',
  `create_by` varchar(36) DEFAULT NULL COMMENT '创建人ID',
  `create_by_name` varchar(50) DEFAULT NULL COMMENT '创建人姓名（快照）',
  `update_time` datetime DEFAULT NULL COMMENT '修改时间',
  `update_by` varchar(36) DEFAULT NULL COMMENT '修改人ID',
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0' COMMENT '逻辑删除',
  `refund_no` varchar(32) NOT NULL COMMENT '退费单号 TK20261002-101',
  `finance_refund_id` varchar(36) DEFAULT NULL COMMENT '财务侧退费单 id（上报后回填）',
  `finance_refund_no` varchar(32) DEFAULT NULL COMMENT '财务侧退费单号 TF20260001',
  `consult_student_id` varchar(36) NOT NULL COMMENT '学生id',
  `student_name` varchar(50) DEFAULT NULL COMMENT '学生姓名快照',
  `student_no` varchar(32) DEFAULT NULL COMMENT '学号快照',
  `class_name` varchar(50) DEFAULT NULL COMMENT '班级快照',
  `apply_by_id` varchar(36) DEFAULT NULL COMMENT '发起人ID',
  `apply_by_name` varchar(50) DEFAULT NULL COMMENT '发起人姓名',
  `apply_by_title` varchar(50) DEFAULT NULL COMMENT '发起人岗位，如「咨询师」「咨询经理」',
  `apply_at` datetime DEFAULT NULL COMMENT '发起时间',
  `self_approve` tinyint(1) NOT NULL DEFAULT '0' COMMENT '是否经理自审自批',
  `approve_by_name` varchar(50) DEFAULT NULL COMMENT '审批人姓名',
  `approve_at` datetime DEFAULT NULL COMMENT '审批通过时间',
  `reject_reason` varchar(200) DEFAULT NULL COMMENT '经理驳回原因',
  `reject_by_name` varchar(50) DEFAULT NULL COMMENT '驳回人',
  `trial_start` date DEFAULT NULL COMMENT '试学开始日期',
  `trial_end` date DEFAULT NULL COMMENT '试学结束日期',
  `trial_days` int NOT NULL DEFAULT '0' COMMENT '试学天数',
  `income_amount` int NOT NULL DEFAULT '0' COMMENT '已到账试学费（分）',
  `deduct_detail` longtext COMMENT '扣减明细JSON',
  `deduct_total` int NOT NULL DEFAULT '0' COMMENT '扣减合计（分）',
  `refund_amount` int NOT NULL DEFAULT '0' COMMENT '应退金额（分）=收入-扣减',
  `status` int NOT NULL DEFAULT '1' COMMENT '状态 1待经理审批 2待财务打款 3已打款 4已驳回',
  `pay_by_name` varchar(50) DEFAULT NULL COMMENT '打款人',
  `pay_at` datetime DEFAULT NULL COMMENT '打款时间',
  `pay_method` varchar(20) DEFAULT NULL COMMENT '打款方式',
  `pay_ref` varchar(64) DEFAULT NULL COMMENT '打款流水号',
  `pay_to` varchar(100) DEFAULT NULL COMMENT '收款人信息',
  `remark` varchar(500) DEFAULT NULL COMMENT '备注/退费原因',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_cr_refund_no` (`refund_no`),
  KEY `idx_cr_student` (`consult_student_id`),
  KEY `idx_cr_status` (`status`),
  KEY `idx_cr_apply_by` (`apply_by_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='咨询退费单表（试学阶段流失）';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `t_consult_refund`
--

LOCK TABLES `t_consult_refund` WRITE;
/*!40000 ALTER TABLE `t_consult_refund` DISABLE KEYS */;
/*!40000 ALTER TABLE `t_consult_refund` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `t_consult_student`
--

DROP TABLE IF EXISTS `t_consult_student`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `t_consult_student` (
  `id` varchar(36) NOT NULL COMMENT '主键UUID',
  `create_time` datetime NOT NULL COMMENT '创建时间',
  `create_by` varchar(36) DEFAULT NULL COMMENT '创建人ID',
  `create_by_name` varchar(50) DEFAULT NULL COMMENT '创建人姓名（快照）',
  `update_time` datetime DEFAULT NULL COMMENT '修改时间',
  `update_by` varchar(36) DEFAULT NULL COMMENT '修改人ID',
  `is_deleted` tinyint(1) NOT NULL DEFAULT '0' COMMENT '逻辑删除',
  `student_no` varchar(32) DEFAULT NULL COMMENT '学号 S20260001（转正式后才有）',
  `student_name` varchar(50) NOT NULL COMMENT '姓名',
  `gender` int NOT NULL COMMENT '性别 1男 2女',
  `age` int DEFAULT NULL COMMENT '年龄',
  `phone` varchar(20) DEFAULT NULL COMMENT '学生手机号',
  `dept_code` int DEFAULT NULL COMMENT '部门 1初高部 2大学部',
  `birthday` varchar(20) DEFAULT NULL COMMENT '出生日期',
  `source_channel` int NOT NULL DEFAULT '1' COMMENT '来源渠道 1家访 2线上咨询 3转介绍 4到校咨询 5电话咨询 9其他',
  `source_remark` varchar(100) DEFAULT NULL COMMENT '来源备注，如「青山社区」',
  `referrer_name` varchar(50) DEFAULT NULL COMMENT '转介绍招生老师姓名（来源=转介绍时填）',
  `referrer_phone` varchar(20) DEFAULT NULL COMMENT '转介绍招生老师手机号',
  `owner_id` varchar(36) DEFAULT NULL COMMENT '跟进人ID（咨询老师）',
  `owner_name` varchar(50) DEFAULT NULL COMMENT '跟进人姓名',
  `owner_title` varchar(50) DEFAULT NULL COMMENT '跟进人岗位',
  `intend_course` varchar(100) DEFAULT NULL COMMENT '意向课程',
  `parent_contact` varchar(50) DEFAULT NULL COMMENT '家长联系人，如「陈建国（父）」',
  `parent_phone` varchar(20) DEFAULT NULL COMMENT '家长电话',
  `id_card` varchar(32) DEFAULT NULL COMMENT '身份证号',
  `school` varchar(100) DEFAULT NULL COMMENT '就读/毕业学校',
  `address` varchar(200) DEFAULT NULL COMMENT '家庭住址',
  `target_college` varchar(100) DEFAULT NULL COMMENT '报考院校',
  `pay_mode` varchar(50) DEFAULT NULL COMMENT '缴费方式说明，如「分期缴纳」',
  `remark` varchar(500) DEFAULT NULL COMMENT '备注',
  `consult_state` int NOT NULL DEFAULT '1' COMMENT '咨询流转状态 1待分配2待面试3试学费待确认4试学中待分班5试学中6缴费中待确认7正式学员8退费待经理9退费待财务10已退费11未报名待跟进12流失13未通过',
  `student_status` int DEFAULT NULL COMMENT '学籍状态（同步给其他模块，取值见 shared-types StudentStatus）',
  `class_id` varchar(36) DEFAULT NULL COMMENT '班级ID',
  `class_name` varchar(50) DEFAULT NULL COMMENT '班级名称',
  `trial_start` date DEFAULT NULL COMMENT '试学开始日期（退费算天数用）',
  `loss_reason` varchar(200) DEFAULT NULL COMMENT '流失原因',
  `arrear_amount` int NOT NULL DEFAULT '0' COMMENT '★ 2026-10-16 欠费金额（分），分期计划待缴余额 > 0 即为欠费',
  PRIMARY KEY (`id`),
  KEY `idx_cs_name` (`student_name`),
  KEY `idx_cs_phone` (`phone`),
  KEY `idx_cs_owner` (`owner_name`),
  KEY `idx_cs_state` (`consult_state`),
  KEY `idx_cs_source` (`source_channel`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='咨询学生档案主表';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `t_consult_student`
--

LOCK TABLES `t_consult_student` WRITE;
/*!40000 ALTER TABLE `t_consult_student` DISABLE KEYS */;
INSERT INTO `t_consult_student` VALUES ('CST-J26011','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'J26011','邓雨欣',2,14,'13810026011',1,'2012-05-12',4,'到校咨询','278d7a01-b3bc-45e1-84aa-154d02734351','张老师','咨询师','IT 就业班','母亲','13910026011','41010020120260119011','郑州市第某中学','河南省郑州市金水区','郑州大学','一次性','初高直建入班',7,5,'CLS-JH-G2601','G2601',NULL,NULL),('CST-J26012','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'J26012','罗佳怡',2,16,'13810026012',1,'2010-05-12',4,'到校咨询','a964420e-2f15-4eea-a565-75b58a0eb626','李老师','咨询师','IT 就业班','母亲','13910026012','41010020100260129012','郑州市第某中学','河南省郑州市金水区','郑州大学','一次性','初高直建入班',7,5,'CLS-JH-J2602','J2602',NULL,NULL),('CST-U26006','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'U26006','杨静怡',2,19,'13810026006',2,'2007-05-12',4,'到校咨询','278d7a01-b3bc-45e1-84aa-154d02734351','张老师','咨询师','IT 就业班','母亲','13910026006','41010020070260069006','郑州市第某中学','河南省郑州市金水区','郑州大学','一次性','已推送 U2602（已接收）',7,5,'CLS-U2602','U2602',NULL,NULL),('CST-U26007','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'U26007','赵一鸣',1,18,'13810026007',2,'2008-05-12',4,'到校咨询','278d7a01-b3bc-45e1-84aa-154d02734351','张老师','咨询师','IT 就业班','母亲','13910026007','41010020080260079007','郑州市第某中学','河南省郑州市金水区','郑州大学','一次性','已推送 U2602（已接收）',7,5,'CLS-U2602','U2602',NULL,NULL),('CST-U26008','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'U26008','孙浩然',1,19,'13810026008',2,'2007-05-12',4,'到校咨询','a964420e-2f15-4eea-a565-75b58a0eb626','李老师','咨询师','IT 就业班','母亲','13910026008','41010020070260089008','郑州市第某中学','河南省郑州市金水区','郑州大学','一次性','已推送 U2602（已接收）',7,5,'CLS-U2602','U2602',NULL,NULL),('CST-U26009','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'U26009','周晓彤',2,18,'13810026009',2,'2008-05-12',4,'到校咨询','a964420e-2f15-4eea-a565-75b58a0eb626','李老师','咨询师','IT 就业班','母亲','13910026009','41010020080260099009','郑州市第某中学','河南省郑州市金水区','郑州大学','一次性','已推送 U2602（已接收）',7,5,'CLS-U2602','U2602',NULL,NULL),('CST-U26010','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'U26010','吴子豪',1,19,'13810026010',2,'2007-05-12',4,'到校咨询','1b6c0d9d-f07f-4808-9b75-0763f68690ff','王经理','咨询经理','IT 就业班','母亲','13910026010','41010020070260109010','郑州市第某中学','河南省郑州市金水区','郑州大学','一次性','已推送 U2602（已接收）',7,5,'CLS-U2602','U2602',NULL,NULL),('CST-U26016','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'U26016','马志远',1,18,'13810026016',2,'2008-05-12',4,'到校咨询','278d7a01-b3bc-45e1-84aa-154d02734351','张老师','咨询师','IT 就业班','母亲','13910026016','41010020080260169016','郑州市第某中学','河南省郑州市金水区','郑州大学','一次性','已推送 U2601（待接收）',7,NULL,NULL,NULL,NULL,NULL),('CST-U26017','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'U26017','何静宜',2,19,'13810026017',2,'2007-05-12',4,'到校咨询','a964420e-2f15-4eea-a565-75b58a0eb626','李老师','咨询师','IT 就业班','母亲','13910026017','41010020070260179017','郑州市第某中学','河南省郑州市金水区','郑州大学','一次性','已推送 U2602（待接收）',7,NULL,NULL,NULL,NULL,NULL),('CST-U26018','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'U26018','高远航',1,18,'13810026018',2,'2008-05-12',4,'到校咨询','1b6c0d9d-f07f-4808-9b75-0763f68690ff','王经理','咨询经理','IT 就业班','母亲','13910026018','41010020080260189018','郑州市第某中学','河南省郑州市金水区','郑州大学','一次性','已推送 U2601（被驳回）',6,NULL,NULL,NULL,NULL,NULL),('CST-ZX26001','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'ZX26001','唐俊杰',1,18,'13810026001',NULL,'2008-05-12',2,'线上留资','278d7a01-b3bc-45e1-84aa-154d02734351','张老师','咨询师','IT 就业班','父亲','13910026001','41010020080260019001','郑州市第某中学','河南省郑州市金水区','郑州大学','一次性','待跟进',1,1,NULL,NULL,NULL,NULL),('CST-ZX26002','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'ZX26002','苏雅雯',2,17,'13810026002',NULL,'2009-05-12',2,'线上留资','a964420e-2f15-4eea-a565-75b58a0eb626','李老师','咨询师','IT 就业班','父亲','13910026002','41010020090260029002','郑州市第某中学','河南省郑州市金水区','郑州大学','一次性','待跟进',2,2,NULL,NULL,NULL,NULL),('CST-ZX26003','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'ZX26003','谢铭轩',1,16,'13810026003',NULL,'2010-05-12',2,'线上留资','a964420e-2f15-4eea-a565-75b58a0eb626','李老师','咨询师','IT 就业班','父亲','13910026003','41010020100260039003','郑州市第某中学','河南省郑州市金水区','郑州大学','一次性','待跟进',11,11,NULL,NULL,NULL,NULL),('CST-ZX26004','2026-10-06 21:25:29','SEED',NULL,'2026-10-06 21:25:29','SEED',0,'ZX26004','郭子睿',1,19,'13810026004',NULL,'2007-05-12',2,'线上留资','a964420e-2f15-4eea-a565-75b58a0eb626','李老师','咨询师','IT 就业班','父亲','13910026004','41010020070260049004','郑州市第某中学','河南省郑州市金水区','郑州大学','一次性','明确不来了',12,11,NULL,NULL,NULL,'已选择其他机构');
/*!40000 ALTER TABLE `t_consult_student` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-10-07  0:08:25
