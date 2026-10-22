<template>
  <div class="tsv">
    <!-- 说明条 -->
    <el-alert class="tsv-tip" type="info" :closable="false" show-icon>
      <template #title>
        学生按<b>部门</b>归类：初高部 / 大学部 / 就业部。
        「全部部门」= 当前账号可见数据合并后<b>按学号去重</b>
        <span class="muted">（同学号保留阶段更靠后的那条：就业部 &gt; 大学 &gt; 初高）</span>
        ；<b>阶段</b>筛选实时跟随「系统设置 · 阶段方案」。
      </template>
    </el-alert>

    <!-- 统计卡片 -->
    <div class="tsv-cards">
      <div class="tsv-card">
        <div class="tsv-card__k">总人数</div>
        <div class="tsv-card__v">{{ summary.total }}</div>
      </div>
      <div class="tsv-card">
        <div class="tsv-card__k">正式在读</div>
        <div class="tsv-card__v ok">{{ summary.studying }}</div>
      </div>
      <div class="tsv-card">
        <div class="tsv-card__k">试学中</div>
        <div class="tsv-card__v">{{ summary.trial }}</div>
      </div>
      <div class="tsv-card">
        <div class="tsv-card__k">休学</div>
        <div class="tsv-card__v warn">{{ summary.suspended }}</div>
      </div>
      <div class="tsv-card">
        <div class="tsv-card__k">退学</div>
        <div class="tsv-card__v danger">{{ summary.quit }}</div>
      </div>
      <div class="tsv-card">
        <div class="tsv-card__k">未分配宿舍</div>
        <div class="tsv-card__v">{{ summary.unassigned }}</div>
      </div>
    </div>

    <!-- 筛选 -->
    <el-form class="tsv-filter" inline>
      <!-- 2026-10-16 按批注：「学段」改叫「部门」；初高 → 初高部、大学 → 大学部 -->
      <el-form-item label="部门">
        <el-select v-model="query.dept" clearable placeholder="全部部门" style="width: 130px" @change="onDeptChange">
          <el-option v-for="d in deptFilterOptions" :key="d.value" :label="d.label" :value="d.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="班级">
        <!-- ★ 选完即查：之前这里没有 @change，选了班级列表不动，
             用户会以为「按班级筛选」没实现（必须再点一次查询才生效） -->
        <el-select v-model="query.classId" clearable filterable placeholder="全部班级" style="width: 180px" @change="load(1)">
          <el-option
            v-for="c in classSelectOptions"
            :key="c.id"
            :label="c.stage ? `${c.name} · ${c.stageName}` : c.name"
            :value="c.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item v-if="schemeStageFilterOptions.length" label="阶段">
        <el-select
          v-model="query.schemeStage"
          clearable
          placeholder="全部"
          style="width: 160px"
          @change="load(1)"
          @visible-change="(v: boolean) => v && refreshMeta()"
        >
          <el-option
            v-for="p in schemeStageFilterOptions"
            :key="p.value"
            :label="p.label"
            :value="p.value"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="状态">
        <el-select v-model="query.studentStatus" clearable placeholder="全部" style="width: 130px" @change="load(1)">
          <el-option
            v-for="(n, v) in STUDENT_STATUS_NAME"
            :key="v"
            :label="n"
            :value="Number(v)"
            :disabled="activeStage ? !statusAllowed(activeStage, Number(v)) : false"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="关键字">
        <el-input
          v-model="query.keyword"
          placeholder="姓名 / 学号 / 手机"
          clearable
          style="width: 170px"
          @keyup.enter="load(1)"
          @clear="load(1)"
        />
      </el-form-item>
      <el-form-item>
        <el-checkbox v-model="query.unassigned" @change="load(1)">只看未分配宿舍</el-checkbox>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="load(1)">查询</el-button>
        <el-button @click="reset">重置</el-button>
        <el-button v-if="!isReadOnlyUser" type="success" @click="openCreate">新增学生</el-button>
        <!-- 2026-10-20 批注：新增【升云】—— 初高部学生批量升入大学部「开放」班级 -->
        <el-button v-if="!isReadOnlyUser && canUpgrade" type="warning" @click="openUpgrade">升云</el-button>
      </el-form-item>
    </el-form>

    <!-- 列表 -->
    <el-table v-loading="loading" :data="rows" border stripe size="small">
      <el-table-column v-if="!query.dept" label="部门" width="80" align="center">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ deptLabelOf(row) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="学号" min-width="100">
        <template #default="{ row }">{{ row.studentNo }}</template>
      </el-table-column>
      <el-table-column label="姓名" min-width="80">
        <template #default="{ row }">{{ row.studentName }}</template>
      </el-table-column>
      <el-table-column label="性别" width="60" align="center">
        <template #default="{ row }">{{ row.genderName || '—' }}</template>
      </el-table-column>
      <el-table-column label="年龄" width="60" align="center">
        <template #default="{ row }">{{ row.age ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="班级" min-width="120">
        <template #default="{ row }">{{ row.className || '—' }}</template>
      </el-table-column>
      <el-table-column label="阶段" min-width="95">
        <!-- ★ 2026-10-21：有阶段方案时段列显示方案阶段名，否则退回阶段码名称 -->
        <template #default="{ row }">{{ row.schemeStageName || row.phaseName || '—' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90" align="center">
        <template #default="{ row }">
          <el-tag :type="statusTag(row.studentStatus)" size="small">{{ row.studentStatusName }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="手机号" min-width="105">
        <template #default="{ row }">{{ row.phone || '—' }}</template>
      </el-table-column>
      <el-table-column label="宿舍" min-width="100">
        <template #default="{ row }">{{ row.bedLabel || row.dormNo || '—' }}</template>
      </el-table-column>
      <el-table-column label="入学时间" min-width="100" align="center">
        <template #default="{ row }">{{ row.enrollDate || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="260" fixed="right" align="center">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openDetail(row)">详情</el-button>
          <!-- ★ 2026-10-20 试学闭环：只有大学学段的「试学中」学生才显示 -->
          <el-button
            v-if="canTrialAct(row)"
            link
            type="success"
            size="small"
            @click="openTrialPlan(row)"
          >
            转正式
          </el-button>
          <el-button v-if="canTrialAct(row)" link type="danger" size="small" @click="openTrialQuit(row)">
            退学
          </el-button>
          <el-button v-if="!isReadOnlyUser" link type="primary" size="small" @click="openEdit(row)">
            编辑
          </el-button>
          <el-button v-if="!isReadOnlyUser" link type="danger" size="small" @click="doDelete(row)">
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="tsv-page"
      :current-page="query.page"
      :page-size="query.size"
      :total="total"
      layout="total, prev, pager, next"
      @current-change="(p: number) => load(p)"
    />

    <!-- 详情（2026-10-15 分签改版：基础信息 / 市场信息 / 末班记录 / 宿舍 / 考试信息 / 校园网账号） -->
    <el-dialog v-model="detailVisible" width="860px" top="5vh">
      <template #header>
        <div class="tsv-dhead" v-if="detail">
          <b>{{ detail.base.studentName }} · 学员详情</b>
          <span class="muted">
            {{ detail.base.studentNo }}<template v-if="detail.base.className"> | {{ detail.base.className }}</template> |
            {{ detail.base.studentStatusName }}
          </span>
        </div>
      </template>
      <template v-if="detail">
        <el-tabs v-model="detailTab">
          <!-- ① 基础信息（按现有界面） -->
          <el-tab-pane label="基础信息" name="base">
            <el-descriptions :column="3" border size="small">
              <el-descriptions-item label="部门">{{ deptLabelOf(detail.base) }}</el-descriptions-item>
              <el-descriptions-item label="学号">{{ detail.base.studentNo }}</el-descriptions-item>
              <el-descriptions-item label="姓名">{{ detail.base.studentName }}</el-descriptions-item>
              <el-descriptions-item label="性别">{{ detail.base.genderName || '—' }}</el-descriptions-item>
              <el-descriptions-item label="年龄">{{ detail.base.age ?? '—' }}</el-descriptions-item>
              <el-descriptions-item label="身份证">{{ detail.profile.idCard || '—' }}</el-descriptions-item>
              <el-descriptions-item label="班级">{{ detail.base.className || '—' }}</el-descriptions-item>
              <el-descriptions-item label="阶段">{{ detail.base.schemeStageName || detail.base.phaseName || '—' }}</el-descriptions-item>
              <el-descriptions-item label="状态">
                <el-tag :type="statusTag(detail.base.studentStatus)" size="small">
                  {{ detail.base.studentStatusName }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="入学日期">{{ detail.base.enrollDate || '—' }}</el-descriptions-item>
              <el-descriptions-item label="出生日期">{{ detail.profile.birthDate || '—' }}</el-descriptions-item>
              <el-descriptions-item label="手机号">{{ detail.base.phone || '—' }}</el-descriptions-item>
              <el-descriptions-item label="家长姓名">{{ detail.base.parentName || '—' }}</el-descriptions-item>
              <el-descriptions-item label="家长手机">{{ detail.base.parentPhone || '—' }}</el-descriptions-item>
              <el-descriptions-item label="学历">{{ detail.base.education || '—' }}</el-descriptions-item>
              <el-descriptions-item label="籍贯">{{ detail.profile.nativePlace || '—' }}</el-descriptions-item>
              <el-descriptions-item label="毕业学校">{{ detail.profile.graduateSchool || '—' }}</el-descriptions-item>
              <el-descriptions-item label="家庭住址" :span="2">
                {{ detail.profile.homeAddress || '—' }}
              </el-descriptions-item>
              <el-descriptions-item label="班主任">{{ detail.base.headTeacherName || '—' }}</el-descriptions-item>
              <el-descriptions-item label="教员">{{ detail.base.teacherName || '—' }}</el-descriptions-item>
              <el-descriptions-item label="助教">{{ detail.base.assistantName || '—' }}</el-descriptions-item>
              <el-descriptions-item label="备注" :span="3">{{ detail.base.remark || '—' }}</el-descriptions-item>
            </el-descriptions>

            <!-- 学段特有区块：有数据才显示（综合素质=大学 / 简历=就业） -->
            <el-descriptions v-if="detail.quality" :column="3" border size="small" title="综合素质" class="tsv-sec">
              <el-descriptions-item label="学习">{{ detail.quality.studyStatus || '—' }}</el-descriptions-item>
              <el-descriptions-item label="纪律">{{ detail.quality.discipline || '—' }}</el-descriptions-item>
              <el-descriptions-item label="能力">{{ detail.quality.ability || '—' }}</el-descriptions-item>
              <el-descriptions-item label="理解">{{ detail.quality.comprehension || '—' }}</el-descriptions-item>
              <el-descriptions-item label="表达">{{ detail.quality.expression || '—' }}</el-descriptions-item>
              <el-descriptions-item label="社交">{{ detail.quality.social || '—' }}</el-descriptions-item>
              <el-descriptions-item label="综合评语" :span="3">{{ detail.quality.note || '—' }}</el-descriptions-item>
            </el-descriptions>

            <el-descriptions v-if="detail.resume" :column="1" border size="small" title="简历" class="tsv-sec">
              <el-descriptions-item label="简历文件">{{ detail.resume.resumeName || '（无）' }}</el-descriptions-item>
            </el-descriptions>

            <!-- ★ 2026-10-20 批注：基础信息里增加「升云记录」（原班级 / 原班主任 / 操作人） -->
            <el-descriptions
              v-if="upgradeRows.length"
              :column="1"
              border
              size="small"
              title="升云记录"
              class="tsv-sec"
            >
              <el-descriptions-item
                v-for="(u, i) in upgradeRows"
                :key="u.id || i"
                :label="u.upgradeTime || `第 ${i + 1} 次升云`"
              >
                <div class="tsv-upg-rec">
                  <span>原班级：<b>{{ u.fromClassName || '—' }}</b></span>
                  <span>原班主任：<b>{{ u.fromHeadTeacherName || '—' }}</b></span>
                  <span>升入班级：<b>{{ u.toClassName || '—' }}</b></span>
                  <span>操作人：<b>{{ u.operatorName || '—' }}</b></span>
                  <span v-if="u.remark" class="muted">备注：{{ u.remark }}</span>
                </div>
              </el-descriptions-item>
            </el-descriptions>

            <el-descriptions v-if="flowRows.length" :column="1" border size="small" title="学籍异动记录" class="tsv-sec">
              <el-descriptions-item v-for="(f, i) in flowRows" :key="i" :label="String(f.flowTypeName || '异动')">
                {{ f.applyTime || '—' }} · {{ f.currentNodeName || '' }} {{ f.rejectReason || '' }}
              </el-descriptions-item>
            </el-descriptions>
          </el-tab-pane>

          <!-- ② 市场信息（同步自市场咨询入班记录，只读） -->
          <el-tab-pane label="市场信息" name="market">
            <el-descriptions :column="3" border size="small">
              <el-descriptions-item label="招生老师">{{ detail.market.recruitTeacherName || '—' }}</el-descriptions-item>
              <el-descriptions-item label="招生电话">{{ detail.market.recruitTeacherPhone || '—' }}</el-descriptions-item>
              <el-descriptions-item label="咨询老师">{{ detail.market.consultTeacherName || '—' }}</el-descriptions-item>
              <el-descriptions-item label="咨询电话" :span="3">
                {{ detail.market.consultTeacherPhone || '—' }}
              </el-descriptions-item>
            </el-descriptions>
            <el-alert
              class="tsv-sec"
              type="info"
              :closable="false"
              show-icon
              title="招生老师 / 咨询老师来自市场咨询入班时同步的记录，此处只读"
            />
          </el-tab-pane>

          <!-- ③ 末班记录（成绩管理「末班」动作落库，此处只读） -->
          <el-tab-pane label="末班记录" name="repeat">
            <el-table :data="repeatRows" border size="small" empty-text="暂无末班记录（由成绩管理的末班功能记录）">
              <el-table-column label="姓名" width="90">
                <template #default="{ row }">{{ row._studentName || detail.base.studentName }}</template>
              </el-table-column>
              <el-table-column label="学号" width="120">
                <template #default="{ row }">{{ row._studentNo || detail.base.studentNo }}</template>
              </el-table-column>
              <el-table-column prop="repeatTime" label="末班时间" width="110">
                <template #default="{ row }">{{ row.repeatTime || '—' }}</template>
              </el-table-column>
              <el-table-column prop="fromClassName" label="原班级" min-width="120">
                <template #default="{ row }">{{ row.fromClassName || '—' }}</template>
              </el-table-column>
              <el-table-column prop="toClassName" label="末班班级" min-width="120">
                <template #default="{ row }">{{ row.toClassName || '—' }}</template>
              </el-table-column>
              <el-table-column prop="repeatCount" label="末班次数" width="90" align="center">
                <template #default="{ row }">{{ row.repeatCount ?? '—' }}</template>
              </el-table-column>
              <el-table-column prop="repeatReason" label="末班原因" min-width="120">
                <template #default="{ row }">{{ row.repeatReason || '—' }}</template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <!-- ④ 宿舍（同步宿舍管理 + 调宿记录） -->
          <el-tab-pane label="宿舍" name="dorm">
            <template v-if="detail.dorm">
              <el-descriptions :column="3" border size="small" title="宿舍信息">
                <el-descriptions-item label="姓名">{{ detail.base.studentName }}</el-descriptions-item>
                <el-descriptions-item label="学号">{{ detail.base.studentNo }}</el-descriptions-item>
                <el-descriptions-item label="宿舍号">{{ detail.dorm.dormNo || '—' }}</el-descriptions-item>
                <el-descriptions-item label="床位号">{{ detail.dorm.bedNo || '—' }}</el-descriptions-item>
                <el-descriptions-item label="楼栋 / 班级">
                  {{ detail.dorm.building || detailExtras?.dormClassName || '—' }}
                </el-descriptions-item>
                <el-descriptions-item label="宿舍负责人">{{ detailExtras?.dormOwnerName || '—' }}</el-descriptions-item>
              </el-descriptions>
              <el-alert
                class="tsv-sec"
                type="warning"
                :closable="false"
                show-icon
                title="床位号展示规则：宿舍号-床位号（如 301-1）。此数据与「宿舍管理」是同一份床位表，任意一侧变更都会同步。"
              />
            </template>
            <el-empty v-else description="未分配宿舍" :image-size="60" />
            <div class="tsv-sec tsv-sub">调宿记录</div>
            <el-table :data="dormChangeRows" border size="small" empty-text="暂无调宿记录">
              <el-table-column prop="changeDate" label="时间" width="110">
                <template #default="{ row }">{{ row.changeDate || '—' }}</template>
              </el-table-column>
              <el-table-column label="原床位" min-width="130">
                <template #default="{ row }">
                  {{ row.bizType === 2 ? '—' : bedJoin(row.oldDormNo, row.oldBedNo) }}
                </template>
              </el-table-column>
              <el-table-column label="现床位" min-width="130">
                <template #default="{ row }">
                  {{ row.bizType === 2 ? '已退宿' : bedJoin(row.newDormNo, row.newBedNo) }}
                </template>
              </el-table-column>
              <el-table-column label="类型" width="100" align="center">
                <template #default="{ row }">{{ row.bizTypeName }}</template>
              </el-table-column>
              <el-table-column prop="changeReason" label="调整原因" min-width="140">
                <template #default="{ row }">{{ row.changeReason || '—' }}</template>
              </el-table-column>
              <el-table-column prop="approvalStatusName" label="状态" width="90" align="center" />
            </el-table>
          </el-tab-pane>

          <!-- ⑤ 考试信息（成绩管理同步：技术考试 / 质素考核） -->
          <el-tab-pane label="考试信息" name="exam">
            <div class="tsv-sub">技术考试</div>
            <el-table :data="techScoreRows" border size="small" empty-text="暂无技术考试成绩（由成绩管理同步）">
              <el-table-column label="姓名 / 学号" min-width="140">
                <template #default="{ row }">{{ row.studentName }} / {{ row.studentNo || '—' }}</template>
              </el-table-column>
              <el-table-column prop="examName" label="考试名称" min-width="110" />
              <el-table-column prop="examDate" label="考试时间" width="105">
                <template #default="{ row }">{{ row.examDate || '—' }}</template>
              </el-table-column>
              <el-table-column prop="totalScore" label="综合成绩" width="90" align="center">
                <template #default="{ row }">{{ row.totalScore ?? '—' }}</template>
              </el-table-column>
              <el-table-column prop="writtenScore" label="笔试分数" width="90" align="center">
                <template #default="{ row }">{{ row.writtenScore ?? '—' }}</template>
              </el-table-column>
              <el-table-column prop="machineScore" label="机试分数" width="90" align="center">
                <template #default="{ row }">{{ row.machineScore ?? '—' }}</template>
              </el-table-column>
              <el-table-column prop="interviewScore" label="面试分数" width="90" align="center">
                <template #default="{ row }">{{ row.interviewScore ?? '—' }}</template>
              </el-table-column>
              <el-table-column prop="remark" label="素质分析（非必填）" min-width="150">
                <template #default="{ row }">{{ row.remark || '—' }}</template>
              </el-table-column>
            </el-table>

            <div class="tsv-sec tsv-sub">质素考核</div>
            <el-table :data="qualityScoreRows" border size="small" empty-text="暂无质素考核成绩（由成绩管理同步）">
              <el-table-column label="姓名 / 学号" min-width="140">
                <template #default="{ row }">{{ row.studentName }} / {{ row.studentNo || '—' }}</template>
              </el-table-column>
              <el-table-column prop="examName" label="考试内容" min-width="120" />
              <el-table-column prop="totalScore" label="考核分数" width="90" align="center">
                <template #default="{ row }">{{ row.totalScore ?? '—' }}</template>
              </el-table-column>
              <el-table-column prop="examDate" label="考试时间" width="105">
                <template #default="{ row }">{{ row.examDate || '—' }}</template>
              </el-table-column>
              <el-table-column prop="remark" label="素质分析（非必填）" min-width="180">
                <template #default="{ row }">{{ row.remark || '—' }}</template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <!-- ⑥ 缴费记录（★ 2026-10-21 新增：同步财务管理「账单明细」，只读） -->
          <el-tab-pane label="缴费记录" name="pay">
            <div v-if="payments.totalCount" class="tsv-pay-sum">
              共 <b>{{ payments.totalCount }}</b> 笔 · 合计
              <b>{{ formatAmount(payments.totalAmount) }}</b>
              <span v-if="payments.latestDate"> · 最近缴费 {{ payments.latestDate }}</span>
            </div>
            <el-alert
              v-if="payments.note"
              :title="payments.note"
              type="info"
              :closable="false"
              show-icon
            />
            <el-collapse v-model="payOpen" class="tsv-pay">
              <el-collapse-item v-for="g in payments.groups" :key="g.key" :name="g.key">
                <template #title>
                  <span class="tsv-pay-title">{{ g.name }}</span>
                  <span class="tsv-pay-meta">
                    {{ g.count }} 笔 · {{ formatAmount(g.amount) }}
                    <template v-if="g.latestDate"> · 最近 {{ g.latestDate }}</template>
                  </span>
                </template>
                <el-table v-if="g.records.length" :data="g.records" border size="small">
                  <el-table-column prop="billNo" label="账单号" min-width="120" />
                  <el-table-column prop="feeTypeName" label="费用类型" width="90" />
                  <el-table-column label="金额" width="110" align="right">
                    <template #default="{ row }">{{ formatAmount(row.amount) }}</template>
                  </el-table-column>
                  <el-table-column prop="date" label="缴费日期" width="105" />
                  <el-table-column label="凭证号" width="120">
                    <template #default="{ row }">{{ row.voucherNo || '—' }}</template>
                  </el-table-column>
                  <el-table-column label="操作人" width="100">
                    <template #default="{ row }">{{ row.operatorName || '—' }}</template>
                  </el-table-column>
                  <el-table-column label="备注" min-width="120">
                    <template #default="{ row }">{{ row.remark || '—' }}</template>
                  </el-table-column>
                </el-table>
                <div v-else class="tsv-pay-empty">暂无{{ g.name }}</div>
              </el-collapse-item>
            </el-collapse>
            <el-alert
              class="tsv-sec"
              type="info"
              :closable="false"
              show-icon
              title="数据实时取自「财务管理 · 账单明细」，此处只读；如有出入请到财务模块核对缴费单"
            />
          </el-tab-pane>

          <!-- ⑦ 校园网账号（系统生成，可修改） -->
          <el-tab-pane v-if="detail.net" label="校园网账号" name="net">
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="上网账号">{{ detail.net.netAccount || '—' }}</el-descriptions-item>
              <el-descriptions-item label="初始密码">{{ detail.net.netInitPassword || '—' }}</el-descriptions-item>
            </el-descriptions>
            <el-alert
              class="tsv-sec"
              type="info"
              :closable="false"
              show-icon
              title="账号由系统按学号自动生成（密码为 8 位随机码），可在「编辑学生」中修改"
            />
          </el-tab-pane>
        </el-tabs>
      </template>
    </el-dialog>

    <!-- ★ 2026-10-20 批注：升云（初高部 → 大学部「开放」班级） -->
    <el-dialog v-model="upgradeVisible" title="升云（初高部 → 大学部）" width="1000px" top="5vh">
      <el-alert class="upg-tip" type="info" :closable="false" show-icon>
        <template #title>
          先勾选初高部学生，再选择要升入的大学部班级（<b>只能选「开放」状态的班级</b>）。
          升云会把档案整体移动到大学部、<b>学号不变</b>，初高部原档案不再显示；
          原班级 / 原班主任 / 操作人会记入该生的「升云记录」。
        </template>
      </el-alert>

      <div class="upg-body">
        <div class="upg-main">
          <div class="upg-bar">
            <el-input
              v-model="upgKeyword"
              placeholder="姓名 / 学号 / 手机"
              clearable
              style="width: 190px"
              @keyup.enter="loadUpgradeStudents(1)"
            />
            <!-- 2026-10-20 批注②：加班级的筛选 -->
            <el-select
              v-model="upgClassId"
              clearable
              filterable
              placeholder="全部班级"
              style="width: 150px"
              @change="loadUpgradeStudents(1)"
            >
              <el-option v-for="c in upgClassOptions" :key="c.id" :label="c.name" :value="c.id" />
            </el-select>
            <el-button @click="loadUpgradeStudents(1)">查询</el-button>
            <span class="muted">共 {{ upgTotal }} 名「初高部 · 正式在读」学生</span>
          </div>
          <el-table
            ref="upgTableRef"
            v-loading="upgLoading"
            :data="upgStudents"
            border
            stripe
            size="small"
            row-key="studentId"
            @selection-change="onUpgSelectionChange"
          >
            <el-table-column type="selection" width="44" reserve-selection />
            <el-table-column label="学号" width="100">
              <template #default="{ row }">{{ row.studentNo }}</template>
            </el-table-column>
            <el-table-column label="姓名" width="85">
              <template #default="{ row }">{{ row.studentName }}</template>
            </el-table-column>
            <el-table-column label="性别" width="55" align="center">
              <template #default="{ row }">{{ row.genderName || '—' }}</template>
            </el-table-column>
            <el-table-column label="原班级" min-width="100">
              <template #default="{ row }">{{ row.className || '—' }}</template>
            </el-table-column>
            <el-table-column label="阶段" width="95">
              <template #default="{ row }">{{ row.phaseName || '—' }}</template>
            </el-table-column>
            <el-table-column label="原班主任" width="90">
              <template #default="{ row }">{{ row.headTeacherName || '—' }}</template>
            </el-table-column>
          </el-table>
          <!-- 2026-10-20 批注①：左下角加「全选」，表格每页 15 人，剩下的翻页 -->
          <div class="upg-foot">
            <el-checkbox
              :model-value="upgPageAllChecked"
              :indeterminate="upgPageIndeterminate"
              :disabled="!upgStudents.length"
              @change="toggleAllPage"
            >
              全选本页
            </el-checkbox>
            <span class="muted">本页已选 {{ upgPageSelectedCount }} / {{ upgStudents.length }}</span>
            <el-pagination
              class="upg-pager"
              small
              background
              layout="total, prev, pager, next"
              :total="upgTotal"
              :page-size="upgPageSize"
              :current-page="upgPage"
              @current-change="onUpgPageChange"
            />
          </div>
        </div>

        <div class="upg-side">
          <div class="upg-side__t">① 目标班级（大学部 · 开放）</div>
          <el-select
            v-model="upgTargetClassId"
            filterable
            placeholder="请选择班级"
            style="width: 100%"
            :loading="upgTargetLoading"
          >
            <el-option
              v-for="c in upgTargets"
              :key="c.id"
              :label="c.phaseName ? `${c.name} · ${c.phaseName}` : c.name"
              :value="c.id"
            />
          </el-select>
          <div v-if="upgTarget" class="upg-target">
            <div>班级：{{ upgTarget.name }}</div>
            <div>阶段：{{ upgTarget.phaseName || '—' }}</div>
            <div>班主任：{{ upgTarget.headTeacherName || '—' }}</div>
          </div>
          <div v-else class="upg-target upg-target--empty">
            {{ upgTargets.length ? '尚未选择班级' : '暂无「开放」状态的大学部班级' }}
          </div>

          <el-divider />

          <div class="upg-side__t">② 已选 {{ upgSelection.length }} 人</div>
          <div class="upg-picked">
            <el-tag
              v-for="s in upgSelection"
              :key="s.studentId"
              size="small"
              closable
              @close="removeUpgPicked(s)"
            >
              {{ s.studentName }}
            </el-tag>
            <span v-if="!upgSelection.length" class="muted">请从左侧勾选学生</span>
          </div>
          <el-input
            v-model="upgRemark"
            class="upg-remark"
            placeholder="备注（选填）"
            maxlength="100"
            show-word-limit
          />
        </div>
      </div>

      <template #footer>
        <el-button @click="upgradeVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="upgSubmitting"
          :disabled="!upgSelection.length || !upgTargetClassId"
          @click="doUpgrade"
        >
          确定升云
        </el-button>
      </template>
    </el-dialog>

    <!-- 新增 / 编辑 -->
    <el-dialog v-model="editVisible" :title="form.id ? '编辑学生' : '新增学生'" width="720px" top="5vh">      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-row :gutter="12">
          <el-col :span="8">
            <!-- ★ 2026-10-22：学号由系统按「LZ+班级编号+序号」生成，不接受手填；
                 编辑时只读展示（生成后终身不变，升云/升实训也不改） -->
            <el-form-item label="学号">
              <el-input
                v-model="form.studentNo"
                disabled
                :placeholder="form.id ? '' : '按「LZ+班级编号+序号」自动生成'"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="姓名" prop="studentName">
              <el-input v-model="form.studentName" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="性别" prop="gender">
              <el-select v-model="form.gender" style="width: 100%">
                <el-option label="男" :value="1" />
                <el-option label="女" :value="2" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <!-- 2026-10-15 改版：原「出生日期」输入框改为身份证号，出生日期/年龄由身份证号自动带出 -->
            <el-form-item label="身份证号" prop="idCard">
              <el-input v-model="form.idCard" maxlength="18" placeholder="录入后自动计算年龄" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="部门">
              <el-select v-model="form.deptCode" clearable placeholder="请选择" style="width: 100%" @change="onFormDeptChange">
                <el-option v-for="(n, v) in DEPT_NAME" :key="v" :label="n" :value="Number(v)" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <!-- 2026-10-15 改版：原「身份证」字段改为「年龄」，按身份证号出生日期自动计算（每年自动更新） -->
            <el-form-item label="年龄">
              <el-input :model-value="agePreview" readonly placeholder="按身份证号自动计算" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="班级" prop="classId">
              <el-select
                v-model="form.classId"
                clearable
                filterable
                placeholder="请选择"
                style="width: 100%"
                @change="onFormClassChange"
              >
                <el-option
                  v-for="c in formClassOptions"
                  :key="c.id"
                  :label="c.name"
                  :value="c.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="阶段">
              <el-select v-model="form.phaseCode" clearable placeholder="请选择" style="width: 100%">
                <el-option v-for="p in formPhaseOptions" :key="p.value" :label="p.label" :value="p.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="状态">
              <el-select v-model="form.studentStatus" style="width: 100%">
                <el-option v-for="(n, v) in formStatusOptions" :key="v" :label="n" :value="Number(v)" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="手机号">
              <el-input v-model="form.phone" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <!-- 2026-10-15 改版：「手机号」后新增【家长姓名】字段 -->
            <el-form-item label="家长姓名">
              <el-input v-model="form.parentName" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="家长手机">
              <el-input v-model="form.parentPhone" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="籍贯">
              <el-input v-model="form.nativePlace" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="学历">
              <!-- 2026-10-15 三次调整：学历固定下拉，不随部门联动，单独选择 -->
              <el-select v-model="form.education" clearable filterable style="width: 100%">
                <el-option v-for="e in EDUCATION_OPTIONS" :key="e" :label="e" :value="e" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="毕业学校">
              <el-input v-model="form.graduateSchool" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="入学日期">
              <el-date-picker v-model="form.enrollDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="宿舍号">
              <!-- 2026-10-15 改版：同步「宿舍管理」的宿舍号，下拉选择 -->
              <el-select
                v-model="form.dormId"
                clearable
                filterable
                placeholder="同步宿舍管理，请选择"
                :loading="dormLoading"
                style="width: 100%"
                @change="onFormDormChange"
              >
                <el-option v-for="r in dormRoomOptions" :key="r.roomId" :label="r.label" :value="r.roomId" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8" v-if="showBed">
            <el-form-item label="床位号">
              <!-- 2026-10-15 改版：根据所选宿舍号同步「宿舍管理」的床位号 -->
              <el-select v-model="form.bedNo" clearable placeholder="请先选择宿舍号" style="width: 100%" :disabled="!form.dormId">
                <el-option v-for="b in formBedOptions" :key="b.value" :label="b.label" :value="b.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <!-- 2026-10-16 按批注：删除「上网账号 / 初始密码」两个输入框（红字「删除框选内容」）。
               账号仍由系统按学号自动生成，详情页「校园网账号」页签照旧只读展示；
               表单 state 保留 → 编辑老学生时原值随保存回传，不会被清空。 -->
          <el-col :span="24">
            <el-form-item label="家庭住址">
              <el-input v-model="form.homeAddress" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="备注">
              <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="500" show-word-limit />
            </el-form-item>
          </el-col>
        </el-row>

        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="部门特有的字段（综合素质 / 校园网 / 简历）目前在详情页只读展示，编辑留待下一批"
        />
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doSave">保存</el-button>
      </template>
    </el-dialog>

    <!-- ============ 试学转正（发起补费） ============ -->
    <el-dialog v-model="trialVisible" title="试学转正 · 发起补费" width="560px">
      <div v-loading="trialLoading">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="班主任只负责「发起补费」，收款仍由咨询老师上传缴费截图、财务核对到账；到账后学生自动转为正式在读"
          class="trial-alert"
        />
        <el-descriptions v-if="trialPlan" :column="2" border size="small">
          <el-descriptions-item label="学生">{{ trialPlan.studentName }}</el-descriptions-item>
          <el-descriptions-item label="班级">{{ trialPlan.className || '—' }}</el-descriptions-item>
          <el-descriptions-item label="全款应缴">{{ money(trialPlan.totalAmount) }}</el-descriptions-item>
          <el-descriptions-item label="已到账">{{ money(trialPlan.arrivedAmount) }}</el-descriptions-item>
          <el-descriptions-item label="还差">
            <b class="trial-missing">{{ money(trialPlan.missingAmount) }}</b>
          </el-descriptions-item>
          <el-descriptions-item label="缺缴项">
            {{ trialPlan.missingTypeNames?.join('、') || '—' }}
          </el-descriptions-item>
        </el-descriptions>
        <el-alert
          v-if="trialPlan && (trialPlan.inFlightAmount || 0) > 0"
          type="warning"
          :closable="false"
          show-icon
          :title="`另有 ${money(trialPlan.inFlightAmount || 0)} 在途（已发起、等财务确认），不要重复收取`"
          class="trial-alert"
        />
        <el-alert
          v-if="trialPlan && trialPlan.allArrived"
          type="success"
          :closable="false"
          show-icon
          title="该生费用已全部到账，点确认会直接转为正式在读（无需补缴）"
          class="trial-alert"
        />
      </div>
      <template #footer>
        <el-button @click="trialVisible = false">取消</el-button>
        <el-button type="primary" :loading="trialSaving" :disabled="!trialPlan" @click="doTrialSupplement">
          {{ trialPlan?.allArrived ? '直接转正式' : '发起补费' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ============ 试学退学（提交退学申请） ============ -->
    <el-dialog v-model="quitVisible" title="退学申请" width="520px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="退学需要审批：班主任发起 → 学管初审 → 校长终审；通过后学籍改为「退学」，咨询侧同步为「流失」"
        class="trial-alert"
      />
      <el-form :model="quitForm" label-width="90px">
        <el-form-item label="学生">
          <span>{{ quitRow?.studentName }}（{{ quitRow?.studentNo }}）</span>
        </el-form-item>
        <el-form-item label="退学原因" required>
          <el-input
            v-model="quitForm.applyReason"
            type="textarea"
            :rows="3"
            maxlength="300"
            show-word-limit
            placeholder="如：试学一周后学生不适应，家长提出退学"
          />
        </el-form-item>
        <el-form-item label="生效日期">
          <el-date-picker
            v-model="quitForm.effectDate"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="quitVisible = false">取消</el-button>
        <el-button type="danger" :loading="quitSaving" @click="doTrialQuit">提交退学申请</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 统一学生档案页（第 2 期）
 * ============================================================
 * 合并了 4 个学段（初高 / 大学 / 就业 / 教务）的学生档案：
 *   · 一个页面 + 学段筛选（不再 4 个页面各一套）
 *   · 4 个学段各自的特有区块（综合素质 / 校园网 / 简历 / 学籍异动）
 *     都按「后端有没有给」来决定显不显示 —— 不写死学段判断
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useBreadcrumbStageKey } from '@/store/breadcrumb';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { DEPT_NAME, DeptCode, StudentStatus, STUDENT_STATUS_NAME } from 'shared-types';
import type { DormRoomItem } from 'shared-types/edu';
import { isReadOnlyUser } from '@/store/permission';
import { visibleStageOptions } from '@/teaching/access';
import { fetchDormList } from '@/api/edu/dorm';
import {
  listStudents,
  getStudentDetail,
  getStudentExtras,
  saveStudent,
  deleteStudent,
  getStudentMeta,
  getStudentSummary,
  listUpgradeTargets,
  upgradeToUniversity,
  type StudentDetail,
  type StudentExtras,
  type StudentPayments,
  type StudentRow,
  type StudentStage,
  type StudentStageMeta,
  type StudentSummary,
  type StudentUpgradeRow,
  type StagePlanOption,
  type UpgradeTargetClass,
} from '@/teaching/api/student';
import { http } from '@/api/request';
// ★ 2026-10-21：缴费记录的金额口径与财务模块一致（分 → ¥x,xxx.xx）
import { formatAmount } from '@/finance/utils/finance';
// ★ 2026-10-20 试学闭环：班主任「转正式（发起补费）」与「退学」
import { fetchTrialPlan, trialSupplement, trialQuit, type TrialPlan } from '@/teaching/api/trial';

/* ---------------- 部门（2026-10-16 批注：学段改叫部门，判权仍不依赖旧路由） ---------------- */
/**
 * ★ 2026-10-21 用户口径：学生档案里删除「就业」「教务」，保留就业部
 *
 *   下拉里原来的 5 项有 3 项不是真部门：
 *     · 就业   = 实训那 5 个学生（U26011~U26015），和「就业部」是同一批人
 *     · 就业部 = 真部门（dept_code=3）
 *     · 教务   = sms_edu 库里的学生副本，教务宿舍模块在用，但档案里没必要再列一遍
 *   现在部门下拉只按**真实部门**（DEPT_NAME 的 1/2/3）生成，一个部门一项。
 */
const STAGE_ORDER: StudentStage[] = ['jh', 'class', 'emp'];
const STAGE_LABEL: Record<StudentStage, string> = {
  jh: '初高部',
  class: '大学部',
  emp: '就业部',
};

/** 部门 code → 承载它的学段（部门下拉按这个顺序生成） */
const STAGE_OF_DEPT: Record<number, StudentStage> = {
  [DeptCode.JUNIOR_SENIOR]: 'jh',
  [DeptCode.UNIVERSITY]: 'class',
  // ★ 就业部：sms_job 里 dept_code=3 的学生（含 stage_key=job 的那 5 个实训学生）
  [DeptCode.EMPLOYMENT]: 'emp',
};

const stageOptions = computed(() => visibleStageOptions('student', STAGE_ORDER, STAGE_LABEL));

/**
 * 部门筛选下拉
 *   只列当前账号**看得见**的学段对应的真实部门，值统一用 dept_code
 *   （后端 list / summary 都认这个参数，一个口径到底）。
 */
type DeptFilter = '' | `d:${number}`;
const deptFilterOptions = computed<Array<{ value: DeptFilter; label: string }>>(() => {
  const visible = new Set(stageOptions.value.map((s) => s.value));
  return [DeptCode.JUNIOR_SENIOR, DeptCode.UNIVERSITY, DeptCode.EMPLOYMENT]
    .filter((code) => visible.has(STAGE_OF_DEPT[code]))
    .map((code) => ({ value: `d:${code}` as DeptFilter, label: DEPT_NAME[code] || '' }));
});

/**
 * 行上的「部门」显示口径
 *   优先取学生自己的部门字段；就业 / 教务来源没有部门，退回学段名，不留空白。
 */
function deptLabelOf(row: { deptName?: string | null; stageName?: string | null }): string {
  return row.deptName || row.stageName || '—';
}

/**
 * 各学段可选的状态（筛选下拉的禁用口径 + 编辑表单的选项来源）
 *
 * ★ 2026-10-20 批注（新增/编辑学生弹窗的「状态」下拉）：
 *   ① 「状态选择，删除待咨询和咨询中」「编辑学生→状态：删除待咨询、咨询中的状态选择」
 *      → 全学段都不再提供 1 待咨询 / 2 咨询中（这两个属于咨询招生环节的状态，
 *        学生档案里不应该手工改）；
 *   ② 「大学部的状态选择同步初中部状态选择保持一致」
 *      → class 直接复用初高部那套，不再单独只有 试学中/正式在读/休学/退学/实训中。
 *
 * 注：4 预在读早在上一版就从**表单**里摘掉了（本数组保留它，只为让筛选下拉
 *     还能筛到历史数据；formStatusOptions 会跳过它）。
 * ★ 2026-10-20 批注（新增学生 · 就业部）：状态要加「实训中」——
 *   升实训后学生状态就是 8，就业部必须能选到它，否则只能靠"历史值兜底"看不能改。
 */
const JH_STATUS_CODES = [3, 4, 5, 6, 7, 8, 9, 10, 11];
const JOB_STATUS_CODES = [6, 7, 8, 9, 10];
const STATUS_BY_STAGE: Record<StudentStage, number[]> = {
  jh: JH_STATUS_CODES,
  class: JH_STATUS_CODES, // ★ 批注：与初高部保持一致
  emp: JOB_STATUS_CODES,
};
function statusAllowed(stage: StudentStage, s: number): boolean {
  return (STATUS_BY_STAGE[stage] || []).includes(s);
}

/* ---------------- 列表 ---------------- */
const loading = ref(false);
const rows = ref<StudentRow[]>([]);
const total = ref(0);
const summary = ref<StudentSummary>({
  total: 0,
  studying: 0,
  trial: 0,
  suspended: 0,
  quit: 0,
  unassigned: 0,
});

const query = reactive({
  /** 部门筛选：'' = 全部；`d:1` 初高部 / `d:2` 大学部 / `d:3` 就业部 */
  dept: '' as DeptFilter,
  classId: '',
  /** 阶段方案阶段：'' = 全部；`scheme:<id>` 某个方案阶段；`none` = 班级没绑方案 */
  schemeStage: '' as string,
  studentStatus: undefined as number | undefined,
  keyword: '',
  unassigned: false,
  page: 1,
  size: 20,
});

/** 当前筛选对应的学段（班级 / 阶段 / 状态 都按它联动；未选部门 = 全部） */
const activeStage = computed<StudentStage | ''>(() => {
  const [kind, v] = String(query.dept || '').split(':');
  if (kind !== 'd') return '';
  return STAGE_OF_DEPT[Number(v)] ?? '';
});

/* 面包屑第 4 级：当前正在查看的学段（筛选器变化时自动同步，页面卸载自动清空） */
useBreadcrumbStageKey(() => activeStage.value || '');

const meta = ref<StudentStageMeta[]>([]);
const classOptions = ref<
  Array<{ stage: StudentStage; stageName: string; id: string; name: string; deptCode?: number; phaseCode?: number }>
>([]);

const classSelectOptions = computed(() =>
  activeStage.value ? classOptions.value.filter((c) => c.stage === activeStage.value) : classOptions.value,
);

/**
 * 「阶段」筛选项 —— ★ 2026-10-21 改读「系统设置 · 阶段方案」
 *
 *   原来取的是写死的阶段码（101~107 / 201~204 / 301），跟系统里配的方案没关系，
 *   方案改了筛选不动。现在：
 *     · 选项 = 方案下的阶段（后端 meta.schemeStageOptions 实时读表）
 *     · 选部门时只列该部门的方案阶段；不选部门时全部方案阶段都列（带方案名区分）
 *     · 结尾固定一项「未设置」—— 班级没绑方案的学生归到这里，
 *       否则他们从任何阶段都筛不出来，等于凭空消失
 */
const schemeStageFilterOptions = computed<Array<{ value: string; label: string }>>(() => {
  const list = activeStage.value ? meta.value.filter((m) => m.stage === activeStage.value) : meta.value;
  const seen = new Map<string, string>();
  for (const m of list) {
    for (const p of m.schemeStageOptions || []) {
      if (seen.has(p.id)) continue;
      const base = activeStage.value ? p.name : `${p.name}（${p.schemeName}）`;
      seen.set(p.id, p.studyMonths ? `${base} · 学制${p.studyMonths}月` : base);
    }
  }
  return [
    ...[...seen.entries()].map(([id, label]) => ({ value: `scheme:${id}`, label })),
    { value: 'none', label: '未设置（班级未绑方案）' },
  ];
});

function params() {
  // 部门 = dept_code 口径（初高 1 / 大学 2 / 就业部 3），后端 list 与 summary 都认
  const [kind, v] = String(query.dept || '').split(':');
  // 阶段 = 方案阶段明细 ID；`none` 表示只看没绑方案的
  const [sk, sv] = String(query.schemeStage || '').split(':');
  return {
    deptCode: kind === 'd' ? Number(v) : undefined,
    schemeStageId: sk === 'scheme' ? sv : undefined,
    noScheme: query.schemeStage === 'none' || undefined,
    classId: query.classId || undefined,
    studentStatus: query.studentStatus,
    keyword: query.keyword || undefined,
    unassigned: query.unassigned || undefined,
    page: query.page,
    size: query.size,
  };
}

async function load(p = query.page) {
  query.page = p;
  loading.value = true;
  try {
    const [page, sum] = await Promise.all([
      listStudents(params()),
      getStudentSummary(params()),
    ]);
    rows.value = page.list;
    total.value = page.total;
    summary.value = sum;
  } finally {
    loading.value = false;
  }
}

/** 切部门：阶段 / 状态 / 班级都是部门内口径，必须清掉再查 */
function onDeptChange() {
  query.classId = '';
  query.schemeStage = '';
  query.studentStatus = undefined;
  load(1);
}

function reset() {
  query.dept = '';
  query.classId = '';
  query.schemeStage = '';
  query.studentStatus = undefined;
  query.keyword = '';
  query.unassigned = false;
  load(1);
}

function statusTag(s: number): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
  if (s === 5 || s === 4) return 'success';
  if (s === 6) return 'warning';
  if (s === 7 || s === 11) return 'danger';
  if (s === 8) return 'primary';
  return 'info';
}

/* ---------------- 详情（2026-10-15 分签改版） ---------------- */
const detailVisible = ref(false);
const detail = ref<StudentDetail | null>(null);
const detailTab = ref('base');
const detailExtras = ref<StudentExtras | null>(null);
const flowRows = computed(() => (detail.value?.flows || []) as Array<Record<string, unknown>>);
/** 末班 / 留级记录（来自成绩管理「末班」动作落库的 t_*_repeat） */
const repeatRows = computed(() => (detail.value?.repeats || []) as Array<Record<string, unknown>>);

async function openDetail(row: StudentRow) {
  detail.value = await getStudentDetail(row.stage, row.studentId);
  detailTab.value = 'base';
  detailExtras.value = null;
  detailVisible.value = true;
  // 扩展区块（考试信息 / 调宿记录 / 宿舍长）按需二次拉取，失败不影响详情展示
  try {
    detailExtras.value = await getStudentExtras(row.stage, row.studentId);
  } catch {
    detailExtras.value = null;
  }
}

/** 调宿 / 退宿记录（宿舍签） */
const dormChangeRows = computed(() => detailExtras.value?.dormChanges || []);

/**
 * ★ 2026-10-21：缴费记录（财务账单明细同步，只读）
 *   默认展开「学费」一组 —— 那是家长最关心的，其它三类点开看。
 */
const payOpen = ref<string[]>(['tuition']);
const EMPTY_PAYMENTS: StudentPayments = {
  groups: [],
  totalCount: 0,
  totalAmount: 0,
  latestDate: null,
  note: null,
};
const payments = computed<StudentPayments>(() => detailExtras.value?.payments ?? EMPTY_PAYMENTS);
/** 技术考试成绩（examType ≠ 2 质素考核） */
const techScoreRows = computed(
  () => (detailExtras.value?.scores || []).filter((s) => s.examType !== 2),
);
/** 质素考核成绩（examType = 2） */
const qualityScoreRows = computed(
  () => (detailExtras.value?.scores || []).filter((s) => s.examType === 2),
);
/** 床位展示规则：宿舍号-床位号（如 301-1） */
function bedJoin(dormNo: string | null | undefined, bedNo: string | null | undefined): string {
  if (!dormNo) return bedNo || '—';
  if (!bedNo) return dormNo;
  return `${dormNo}-${bedNo}`;
}

/* ---------------- 新增 / 编辑 ---------------- */
const editVisible = ref(false);
const saving = ref(false);
const formRef = ref<FormInstance>();

const emptyForm = () => ({
  stage: 'jh' as StudentStage,
  id: '' as string | undefined,
  studentNo: '',
  studentName: '',
  gender: 1,
  birthDate: '' as string | null,
  nativePlace: '',
  deptCode: undefined as number | undefined,
  classId: '',
  className: '',
  phaseCode: undefined as number | undefined,
  studentStatus: undefined as number | undefined,
  education: '',
  graduateSchool: '',
  enrollDate: '' as string | null,
  phone: '',
  parentName: '',
  parentPhone: '',
  homeAddress: '',
  idCard: '',
  recruitTeacherName: '',
  recruitTeacherPhone: '',
  consultTeacherName: '',
  consultTeacherPhone: '',
  dormId: '',
  dormNo: '',
  bedNo: '',
  netAccount: '',
  netInitPassword: '',
  remark: '',
});
const form = reactive(emptyForm());
/** 编辑时带入的原年龄（身份证号算不出时的兜底展示） */
const formAge = ref<number | null>(null);

const rules: FormRules = {
  studentName: [{ required: true, message: '姓名必填', trigger: 'blur' }],
  gender: [{ required: true, message: '性别必填', trigger: 'change' }],
  // ★ 2026-10-22：学号按班级编号生成，没班级就没有学号 → 新增时班级必填
  //   （编辑历史学生时放宽：老数据可能本来就没班级，不能因此改不了别的字段）
  classId: [
    {
      // required 只负责显示红星，真正的判断在 validator 里（编辑时允许为空）
      required: true,
      validator: (_r, v: string, cb) => {
        if (form.id || v) cb();
        else cb(new Error('请选择班级（学号按班级编号生成）'));
      },
      trigger: 'change',
    },
  ],
  idCard: [
    {
      validator: (_r, v: string, cb) => {
        if (!v || /^(\d{15}|\d{17}[\dXx])$/.test(v.trim())) cb();
        else cb(new Error('身份证号格式不正确（15 或 18 位）'));
      },
      trigger: 'blur',
    },
  ],
};

/* ============ 2026-10-15 表单改版：身份证号 → 年龄 ============ */

/** 从身份证号提取出生日期（YYYY-MM-DD），提取不出返回 null */
function birthFromIdCard(idc: unknown): string | null {
  const s = String(idc ?? '').trim();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (/^\d{17}[\dXx]$/.test(s)) {
    const y = Number(s.slice(6, 10));
    const m = Number(s.slice(10, 12));
    const d = Number(s.slice(12, 14));
    return validYmd(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
  }
  if (/^\d{15}$/.test(s)) {
    const y = 1900 + Number(s.slice(6, 8));
    const m = Number(s.slice(8, 10));
    const d = Number(s.slice(10, 12));
    return validYmd(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
  }
  return null;
}
function validYmd(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > new Date().getFullYear() || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
/** 由出生日期算周岁 */
function calcAgeClient(birth: string): number | null {
  const b = new Date(`${birth}T00:00:00`);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}
/** 表单「年龄」展示：优先按身份证号实时算，算不出回退原年龄 */
const agePreview = computed<number | ''>(() => {
  const birth = birthFromIdCard(form.idCard);
  if (birth) return calcAgeClient(birth) ?? '';
  return formAge.value ?? '';
});

/* ============ 2026-10-15 表单改版：部门驱动学段 / 阶段 / 学历 ============ */

/** 初高部可选阶段：初中部1期 ~ 高中部3期（批注口径，不含预科与大学阶段码） */
const JH_PHASE_CODES = [102, 103, 104, 105, 106, 107];
/** 学历下拉选项（2026-10-15 三次调整：固定选项，不随部门联动，单独选择） */
const EDUCATION_OPTIONS = ['初中', '高中', '专科', '本科', '研究生'];

/** ★ 2026-10-16 全部阶段方案（来自后端 meta；两个部门的方案都在里面） */
const planOptionsAll = computed<StagePlanOption[]>(
  () => meta.value.find((m) => m.planOptions?.length)?.planOptions || [],
);
/** 部门变化 → 自动判定学段（初高部 → 初高；大学部 → 大学）。
 * 就业/教务学段没有部门概念，编辑这两类学生时不改学段。
 */
function onFormDeptChange(v: number | undefined) {
  if (v === DeptCode.JUNIOR_SENIOR) form.stage = 'jh';
  else if (v === DeptCode.UNIVERSITY) form.stage = 'class';
  // 就业部 = 学段 emp（学生档案里已没有「就业/job」这个学段）
  else if (v === DeptCode.EMPLOYMENT && form.stage !== 'emp') {
    form.stage = 'emp';
  }
  // 学段变了：阶段 / 班级按新学段重选
  if (!formPhaseOptions.value.some((p) => p.value === form.phaseCode)) form.phaseCode = undefined;
  if (!formClassOptions.value.some((c) => c.id === form.classId)) {
    form.classId = '';
    form.className = '';
  }
}

/* ============ 2026-10-15 表单改版：宿舍号 / 床位号同步宿舍管理 ============ */

const dormLoading = ref(false);
const dormRooms = ref<DormRoomItem[]>([]);

async function loadDormRooms() {
  dormLoading.value = true;
  try {
    // ⚠️ /api/edu/dorm/list 的 size 上限是 200（zod 校验），一次拉 500 会被
    //   「参数 size 超出允许范围」400 拒掉 —— 这里按 200/页自动翻页拉全量
    const out: DormRoomItem[] = [];
    const size = 200;
    const first = await fetchDormList({ page: 1, size });
    out.push(...(first.list || []));
    const pages = Math.ceil((first.total || 0) / size);
    for (let p = 2; p <= Math.min(pages, 10); p++) {
      const d = await fetchDormList({ page: p, size });
      out.push(...(d.list || []));
    }
    dormRooms.value = out;
  } catch {
    dormRooms.value = [];
  } finally {
    dormLoading.value = false;
  }
}

const dormRoomOptions = computed(() =>
  dormRooms.value.map((r) => ({
    roomId: r.roomId,
    label: r.building ? `${r.building}-${r.room}` : r.room,
  })),
);

/** 床位下拉：取所选宿舍的床位；老数据只有床位号没匹配到宿舍时，兜底展示原值 */
const formBedOptions = computed(() => {
  const room = dormRooms.value.find((r) => r.roomId === form.dormId);
  if (room) {
    return room.beds.map((b) => ({
      value: b.bedNo,
      label: b.studentName ? `${b.bedNo}（${b.studentName}）` : b.bedNo,
    }));
  }
  return form.bedNo ? [{ value: form.bedNo, label: form.bedNo }] : [];
});

function onFormDormChange(roomId: string) {
  const r = dormRooms.value.find((x) => x.roomId === roomId);
  // ★ 2026-10-20：清空宿舍时要连 dorm_no 一起清（原来只清床位号，导致
  //   「移出宿舍」实际上把旧房号又存回去，也让保存前的变更清单漏掉这一项）
  form.dormNo = r ? (r.building ? `${r.building}-${r.room}` : r.room) : '';
  form.bedNo = '';
}

/**
 * 床位号入库口径：
 *   初高表 bed_no 是字符串（'1-上' 可直接存）；
 *   大学表 bed_no 是整数列 → 把床位号转成床位序号（1~8）再存。
 */
function normalizeBedNo(): string | null {
  const bed = (form.bedNo || '').trim();
  if (!bed) return null;
  if (form.stage === 'class' && !/^\d+$/.test(bed)) {
    const room = dormRooms.value.find((x) => x.roomId === form.dormId);
    const b = room?.beds.find((x) => x.bedNo === bed);
    if (b) return String(b.bedIndex);
  }
  return bed;
}

/** 表单里班级下拉：按当前表单学段过滤 */
const formClassOptions = computed(() =>
  classOptions.value.filter((c) => c.stage === form.stage),
);
/** 表单里阶段下拉：★ 2026-10-16 改为「阶段方案驱动」——
 *   有方案数据时用方案里的阶段（按部门过滤），否则回落到 meta 的阶段清单
 *   （回落时初高仍按旧口径过滤掉预科）。
 *   ★ 2026-10-19：就业部（含实训，部门都是 3）也走方案，不再写死一/二/三阶段。 */
const formPhaseOptions = computed(() => {
  // 就业部覆盖「实训 / 就业部」两个学段，部门编码都是 3
  const dept =
    form.deptCode ??
    (form.stage === 'jh' ? 1 : form.stage === 'class' ? 2 : 3);
  const seen = new Map<number, string>();
  for (const pl of planOptionsAll.value) {
    if (dept && pl.deptCode !== dept) continue;
    for (const ph of pl.phases) if (!seen.has(ph.value)) seen.set(ph.value, ph.label);
  }
  let list: Array<{ value: number; label: string }>;
  if (seen.size) {
    list = [...seen].map(([value, label]) => ({ value, label }));
  } else {
    const base = meta.value.find((m) => m.stage === form.stage)?.phaseOptions || [];
    list = form.stage === 'jh' ? base.filter((p) => JH_PHASE_CODES.includes(p.value)) : base;
  }
  // 兜底：老学生的阶段码可能不在当前方案里（如方案只配了 201~203，学生是 206），
  // 不补一条的话阶段下拉会显示成裸数字 206。只补显示，不改数据。
  const cur = Number(form.phaseCode);
  if (cur && !list.some((p) => p.value === cur)) {
    let label = '';
    for (const pl of planOptionsAll.value) {
      const p = pl.phases.find((x) => x.value === cur);
      if (p) { label = p.label; break; }
    }
    if (!label) {
      for (const m of meta.value) {
        const p = m.phaseOptions.find((x) => x.value === cur);
        if (p) { label = p.label; break; }
      }
    }
    if (label) list = [...list, { value: cur, label }];
  }
  return list;
});
/** 表单里状态下拉：按该学段允许的状态
 *  ★ 2026-10-16 按批注：去掉「预在读」（截图红框 + 红字「删除这个选择」）——
 *    新增 / 编辑学生时不再提供这个选项。
 *  ★ 2026-10-20 按批注：再删「待咨询 / 咨询中」，且大学部与初高部保持一致
 *    （口径见上面 STATUS_BY_STAGE 的注释）。 */
const formStatusOptions = computed(() => {
  const allow = STATUS_BY_STAGE[form.stage] || [];
  const out: Record<number, string> = {};
  for (const s of allow) {
    if (s === StudentStatus.PRE_STUDY) continue;
    out[s] = STUDENT_STATUS_NAME[s] || String(s);
  }
  // 历史数据兜底：编辑老学生时，其状态可能已不在可选列表里（如「预在读 / 待咨询」），
  // 补进选项只为**显示**原名，避免下拉显示成裸数字；用户仍可改选成其它状态。
  const cur = Number(form.studentStatus);
  if (cur && !out[cur] && STUDENT_STATUS_NAME[cur]) out[cur] = STUDENT_STATUS_NAME[cur];
  return out;
});
/** 是否显示床位号：就业/教务表没有 bed_no 列 */
const showBed = computed(() => form.stage === 'class' || form.stage === 'jh');

function openCreate() {
  Object.assign(form, emptyForm());
  // 表单已没有「学段」选择器：默认取筛选中的部门对应学段（就业/教务从对应来源进入仍可新增），
  // 选了部门后会由 onFormDeptChange 自动改判为 初高/大学
  const st = (activeStage.value || stageOptions.value[0]?.value || 'jh') as StudentStage;
  form.stage = st;
  // 2026-10-15 按用户要求：部门不预选默认值，由用户自己选（未选部门时学历下拉显示并集）
  formAge.value = null;
  editOrigin.value = null;
  editVisible.value = true;
}

async function openEdit(row: StudentRow) {
  const d = await getStudentDetail(row.stage, row.studentId);
  const b = d.base;
  Object.assign(form, {
    ...emptyForm(),
    stage: b.stage,
    id: b.studentId,
    studentNo: b.studentNo,
    studentName: b.studentName,
    gender: b.gender || 1,
    birthDate: d.profile.birthDate || '',
    nativePlace: d.profile.nativePlace || '',
    deptCode: b.deptCode ?? undefined,
    classId: b.classId || '',
    className: b.className || '',
    phaseCode: b.phaseCode ?? undefined,
    studentStatus: b.studentStatus,
    education: b.education || '',
    graduateSchool: d.profile.graduateSchool || '',
    enrollDate: b.enrollDate || '',
    phone: b.phone || '',
    parentName: b.parentName || '',
    parentPhone: b.parentPhone || '',
    homeAddress: d.profile.homeAddress || '',
    idCard: d.profile.idCard || '',
    recruitTeacherName: d.market.recruitTeacherName || '',
    recruitTeacherPhone: d.market.recruitTeacherPhone || '',
    consultTeacherName: d.market.consultTeacherName || '',
    consultTeacherPhone: d.market.consultTeacherPhone || '',
    dormId: b.dormId || dormRoomOptions.value.find((r) => r.label === b.dormNo)?.roomId || '',
    dormNo: b.dormNo || '',
    bedNo: b.bedNo || '',
    netAccount: d.net?.netAccount || '',
    netInitPassword: d.net?.netInitPassword || '',
    remark: b.remark || '',
  });
  formAge.value = b.age ?? null;
  // ★ 2026-10-20：留一份原始快照，保存时用它算「改了哪些内容」
  editOrigin.value = { ...form };
  editVisible.value = true;
}

function onFormClassChange(id: string) {
  const c = formClassOptions.value.find((x) => x.id === id);
  form.className = c?.name || '';
  // ★ 2026-10-16「学生档案的阶段、部门跟随学生所在班级」：
  //   选了班级就自动带出该班的部门与阶段（仍可在下拉里手动改，覆盖自动值）
  if (c) {
    if (c.deptCode) form.deptCode = c.deptCode;
    if (c.phaseCode) form.phaseCode = c.phaseCode;
  }
}

/* ---------------- ★ 2026-10-20 批注：编辑保存前先列「我改了什么」 ----------------
 * 批注原文：「若更改编辑学生，点击保存，则会出现我修改的内容有什么，是否更改」
 * 做法：打开编辑时留一份快照（editOrigin），点保存时逐字段比出差异，
 *   有差异 → 弹「确认修改内容」（原值 → 新值，逐条），确认后才真正提交；
 *   无差异 → 直接提示「未检测到修改内容」并关闭，不发请求。
 */
const editOrigin = ref<Record<string, any> | null>(null);

interface DiffRow {
  label: string;
  from: string;
  to: string;
}

/** 变更清单里的文字一律转义 —— 姓名/备注是用户输入，直接拼 HTML 会有注入风险 */
function escHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function buildStudentDiff(): DiffRow[] {
  const o = editOrigin.value;
  if (!o) return [];
  const txt = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
  const genderText = (v: unknown) => (Number(v) === 1 ? '男' : Number(v) === 2 ? '女' : '');
  const deptText = (v: unknown) =>
    v === null || v === undefined || v === '' ? '' : DEPT_NAME[Number(v)] || String(v);
  const classText = (id: unknown, name: unknown) => {
    if (!id) return '';
    return classOptions.value.find((c) => c.id === String(id))?.name || txt(name);
  };
  const phaseText = (v: unknown) => {
    if (v === null || v === undefined || v === '') return '';
    const n = Number(v);
    // 阶段可能已被方案改名/停用，先查方案，再查学段 meta，最后兜底数字
    for (const pl of planOptionsAll.value) {
      const p = pl.phases.find((x) => x.value === n);
      if (p) return p.label;
    }
    for (const m of meta.value) {
      const p = m.phaseOptions.find((x) => x.value === n);
      if (p) return p.label;
    }
    return String(n);
  };
  const statusText = (v: unknown) =>
    v === null || v === undefined || v === '' ? '' : STUDENT_STATUS_NAME[Number(v)] || String(v);

  const pairs: Array<[string, string, string]> = [
    ['学号', txt(o.studentNo), txt(form.studentNo)],
    ['姓名', txt(o.studentName), txt(form.studentName)],
    ['性别', genderText(o.gender), genderText(form.gender)],
    ['身份证号', txt(o.idCard), txt(form.idCard)],
    ['部门', deptText(o.deptCode), deptText(form.deptCode)],
    ['班级', classText(o.classId, o.className), classText(form.classId, form.className)],
    ['阶段', phaseText(o.phaseCode), phaseText(form.phaseCode)],
    ['状态', statusText(o.studentStatus), statusText(form.studentStatus)],
    ['手机号', txt(o.phone), txt(form.phone)],
    ['家长姓名', txt(o.parentName), txt(form.parentName)],
    ['家长手机', txt(o.parentPhone), txt(form.parentPhone)],
    ['籍贯', txt(o.nativePlace), txt(form.nativePlace)],
    ['学历', txt(o.education), txt(form.education)],
    ['毕业学校', txt(o.graduateSchool), txt(form.graduateSchool)],
    ['入学日期', txt(o.enrollDate), txt(form.enrollDate)],
    ['宿舍号', txt(o.dormNo), txt(form.dormNo)],
    ['床位号', txt(o.bedNo), txt(form.bedNo)],
    ['家庭住址', txt(o.homeAddress), txt(form.homeAddress)],
    ['备注', txt(o.remark), txt(form.remark)],
  ];
  return pairs
    .filter(([, a, b]) => a !== b)
    .map(([label, from, to]) => ({ label, from, to }));
}

/** 弹「确认修改内容」：返回 true 才继续保存 */
async function confirmStudentDiff(diffs: DiffRow[]): Promise<boolean> {
  const rows = diffs
    .map(
      (d) =>
        `<div style="line-height:2;font-size:13px">` +
        `<span style="color:#606266">${escHtml(d.label)}：</span>` +
        `<span style="color:#909399;text-decoration:line-through">${escHtml(d.from) || '（空）'}</span>` +
        `<span style="color:#909399"> → </span>` +
        `<b style="color:#d93026">${escHtml(d.to) || '（空）'}</b>` +
        `</div>`,
    )
    .join('');
  const html =
    `<div style="max-height:46vh;overflow:auto">${rows}</div>` +
    `<div style="margin-top:8px;font-size:12px;color:#909399">共 ${diffs.length} 项修改，确认后才会保存。</div>`;
  try {
    await ElMessageBox.confirm(html, '确认修改内容', {
      dangerouslyUseHTMLString: true,
      confirmButtonText: '确定保存',
      cancelButtonText: '返回修改',
      type: 'warning',
    });
    return true;
  } catch {
    return false;
  }
}

async function doSave() {
  if (!formRef.value) return;
  const ok = await formRef.value.validate().catch(() => false);
  if (!ok) return;
  if (form.stage !== 'jh' && !form.deptCode) {
    ElMessage.warning('「部门」必填');
    return;
  }
  // ★ 2026-10-20 批注：编辑时先亮出「改了哪些内容」，用户确认后才提交
  if (form.id) {
    const diffs = buildStudentDiff();
    if (!diffs.length) {
      ElMessage.info('未检测到修改内容');
      editVisible.value = false;
      return;
    }
    if (!(await confirmStudentDiff(diffs))) return;
  }
  saving.value = true;
  try {
    // ★ 出生日期不再手工填：优先从身份证号提取，编辑老数据时保留原有出生日期兜底
    const birth = birthFromIdCard(form.idCard) || form.birthDate || null;
    const r = await saveStudent({
      stage: form.stage,
      id: form.id,
      studentNo: form.studentNo || undefined,
      studentName: form.studentName,
      gender: form.gender,
      birthDate: birth,
      nativePlace: form.nativePlace || null,
      deptCode: form.deptCode ?? null,
      classId: form.classId || null,
      className: form.className || null,
      phaseCode: form.phaseCode ?? null,
      studentStatus: form.studentStatus,
      education: form.education || null,
      graduateSchool: form.graduateSchool || null,
      enrollDate: form.enrollDate || null,
      phone: form.phone || null,
      parentName: form.parentName || null,
      parentPhone: form.parentPhone || null,
      homeAddress: form.homeAddress || null,
      idCard: form.idCard || null,
      recruitTeacherName: form.recruitTeacherName || null,
      recruitTeacherPhone: form.recruitTeacherPhone || null,
      consultTeacherName: form.consultTeacherName || null,
      consultTeacherPhone: form.consultTeacherPhone || null,
      dormId: form.dormId || null,
      dormNo: form.dormNo || null,
      bedNo: showBed.value ? normalizeBedNo() : undefined,
      netAccount: form.stage === 'jh' ? form.netAccount || null : undefined,
      netInitPassword: form.stage === 'jh' ? form.netInitPassword || null : undefined,
      remark: form.remark || null,
    });
    let tip = form.id ? '已保存' : '已新增';
    if (r.frozenCount) tip += `，同步冻结 ${r.frozenCount} 条缴费记录`;
    else if (r.unfrozenCount) tip += `，同步解冻 ${r.unfrozenCount} 条缴费记录`;
    ElMessage.success(tip);
    editVisible.value = false;
    load();
  } catch (e) {
    ElMessage.error((e as Error).message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function doDelete(row: StudentRow) {
  try {
    await ElMessageBox.confirm(
      `确认删除「${deptLabelOf(row)} · ${row.studentName}（${row.studentNo}）」？删除后为逻辑删除，可在数据库中找回。`,
      '删除确认',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  await deleteStudent(row.stage, row.studentId);
  ElMessage.success('已删除');
  load();
}

/* ---------------- ★ 升云（2026-10-20 批注） ----------------
 * 批注：「增加【升云】功能：点击升云可以批量选择人员进行升云，只适用于初高中，
 *   选择人员后再进行大学部要升入班级的选择，只能选择班级状态为开放的。」
 * 口径：只列初高部「正式在读」学生；目标班级只列大学部「开放」班（后端过滤 + 兜底校验）。
 * 结果：档案移到大学部（学号不变），初高部原档案逻辑删除，详情「基础信息」留一条升云记录。
 */
/** 同时能看「初高部」和「大学部」才显示按钮 —— 升云本身就是跨这两个部门 */
const canUpgrade = computed(
  () =>
    stageOptions.value.some((s) => s.value === 'jh') &&
    stageOptions.value.some((s) => s.value === 'class'),
);

const upgradeVisible = ref(false);
const upgLoading = ref(false);
const upgSubmitting = ref(false);
const upgStudents = ref<StudentRow[]>([]);
const upgSelection = ref<StudentRow[]>([]);
const upgKeyword = ref('');
/** 2026-10-20 批注②：升云弹窗内的「班级」筛选（初高部班级） */
const upgClassId = ref('');
/** 2026-10-20 批注①：每页 15 人，剩下的翻页 */
const upgPage = ref(1);
const upgPageSize = 15;
const upgTotal = ref(0);
const upgTargets = ref<UpgradeTargetClass[]>([]);
const upgTargetClassId = ref('');
const upgTargetLoading = ref(false);
const upgRemark = ref('');
const upgTableRef = ref<any>();
const upgTarget = computed(() => upgTargets.value.find((c) => c.id === upgTargetClassId.value) || null);
/** 详情「基础信息」里的升云记录 */
const upgradeRows = computed<StudentUpgradeRow[]>(() => detail.value?.upgrades || []);
/** 升云弹窗的班级下拉：直接复用页面的班级清单，只要初高部 */
const upgClassOptions = computed(() =>
  classOptions.value.filter((c) => c.stage === 'jh').map((c) => ({ id: c.id, name: c.name })),
);
/** 本页已选人数（跨页选择也保留） */
const upgPageSelectedCount = computed(() => {
  const picked = new Set(upgSelection.value.map((s) => s.studentId));
  return upgStudents.value.filter((s) => picked.has(s.studentId)).length;
});
const upgPageAllChecked = computed(
  () => upgStudents.value.length > 0 && upgPageSelectedCount.value === upgStudents.value.length,
);
const upgPageIndeterminate = computed(
  () => upgPageSelectedCount.value > 0 && !upgPageAllChecked.value,
);

async function openUpgrade() {
  upgradeVisible.value = true;
  upgKeyword.value = '';
  upgClassId.value = '';
  upgRemark.value = '';
  upgSelection.value = [];
  upgTargetClassId.value = '';
  upgPage.value = 1;
  upgTableRef.value?.clearSelection?.();
  await Promise.all([loadUpgradeStudents(1), loadUpgradeTargets()]);
}

/** 可升云学生：初高部 + 正式在读（批注口径：只有正式在读可升云），每页 15 人 */
async function loadUpgradeStudents(page = upgPage.value) {
  upgLoading.value = true;
  try {
    const r = await listStudents({
      stage: 'jh',
      studentStatus: StudentStatus.STUDYING,
      classId: upgClassId.value || undefined,
      keyword: upgKeyword.value || undefined,
      page,
      size: upgPageSize,
    });
    upgStudents.value = r.list;
    upgTotal.value = r.total;
    upgPage.value = r.page;
  } catch {
    upgStudents.value = [];
    upgTotal.value = 0;
  } finally {
    upgLoading.value = false;
  }
}

function onUpgPageChange(p: number) {
  loadUpgradeStudents(p);
}

/** 左下角「全选本页」：只勾选/取消当前页（跨页已选的保留） */
function toggleAllPage(val: boolean | string | number) {
  const on = !!val;
  for (const row of upgStudents.value) {
    upgTableRef.value?.toggleRowSelection?.(row, on);
  }
}

/** 目标班级：后端只返回「大学部 + 状态=开放」的班 */
async function loadUpgradeTargets() {
  upgTargetLoading.value = true;
  try {
    upgTargets.value = await listUpgradeTargets();
  } catch {
    upgTargets.value = [];
  } finally {
    upgTargetLoading.value = false;
  }
}

function onUpgSelectionChange(rows: StudentRow[]) {
  upgSelection.value = rows;
}

/** 点已选标签的 ×：同步取消表格勾选 */
function removeUpgPicked(row: StudentRow) {
  upgTableRef.value?.toggleRowSelection?.(row, false);
}

async function doUpgrade() {
  if (!upgSelection.value.length) {
    ElMessage.warning('请先勾选要升云的学生');
    return;
  }
  if (!upgTargetClassId.value) {
    ElMessage.warning('请选择要升入的大学部班级');
    return;
  }
  const target = upgTarget.value;
  const names = upgSelection.value.map((s) => s.studentName).join('、');
  try {
    await ElMessageBox.confirm(
      `确认把 ${upgSelection.value.length} 名学生（${names}）升云到「${target?.name || ''}」？升云后档案移到大学部、学号不变，初高部不再显示该生。`,
      '升云确认',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  upgSubmitting.value = true;
  try {
    const r = await upgradeToUniversity({
      studentIds: upgSelection.value.map((s) => s.studentId),
      targetClassId: upgTargetClassId.value,
      remark: upgRemark.value || null,
    });
    if (r.skipped?.length) {
      const lines = r.skipped.map((x) => `${x.studentName || x.studentNo}：${x.reason}`).join('；');
      await ElMessageBox.alert(
        `已升云 ${r.moved} 人 → ${r.toClassName}。以下 ${r.skipped.length} 人未处理：${lines}`,
        '升云结果',
        { type: 'warning' },
      );
    } else {
      ElMessage.success(`已升云 ${r.moved} 人 → ${r.toClassName}`);
    }
    upgradeVisible.value = false;
    upgSelection.value = [];
    await load(1);
  } catch (e) {
    ElMessage.error((e as Error).message || '升云失败');
  } finally {
    upgSubmitting.value = false;
  }
}

/* ---------------- 初始化 ---------------- */
async function loadAux() {
  meta.value = await getStudentMeta();
  try {
    classOptions.value = await http.get('/api/teaching/student/classes');
  } catch {
    classOptions.value = [];
  }
}

/**
 * ★ 2026-10-21：阶段方案改了不用刷页面 —— 每次展开「阶段」下拉先拉一次 meta，
 *   选项即时反映系统设置里新增 / 改名的阶段。
 */
async function refreshMeta() {
  try {
    meta.value = await getStudentMeta();
  } catch {
    /* 拉不到就沿用旧选项，不打断筛选 */
  }
}

onMounted(async () => {
  await loadAux();
  // 宿舍号/床位号下拉的数据源（宿舍管理）；失败不阻塞页面
  loadDormRooms();
  await load(1);
});

/* ============================================================
 * ★ 2026-10-20 试学闭环（用户口径）
 *   交试学费 → 分配班级 → 试学中
 *     ├─ 试学有问题 → 退学（班主任发起 → 学管 → 校长）
 *     └─ 试学通过   → 班主任发起补费 → 补缴到账 → 正式在读
 *
 * 只有【大学学段】有试学概念（初高另有自己的流程，就业/教务没有），
 * 所以按钮只在 stage === 'class' 且状态为「试学中(3)」时出现。
 * ============================================================ */

const trialVisible = ref(false);
const trialLoading = ref(false);
const trialSaving = ref(false);
const trialPlan = ref<TrialPlan | null>(null);
const trialRow = ref<StudentRow | null>(null);

const quitVisible = ref(false);
const quitSaving = ref(false);
const quitRow = ref<StudentRow | null>(null);
const quitForm = reactive({ applyReason: '', effectDate: '' as string });

function canTrialAct(row: StudentRow): boolean {
  return !isReadOnlyUser.value && row.stage === 'class' && row.studentStatus === 3;
}

function money(cent?: number | null): string {
  return `¥${((Number(cent) || 0) / 100).toFixed(2)}`;
}

async function openTrialPlan(row: StudentRow) {
  trialRow.value = row;
  trialPlan.value = null;
  trialVisible.value = true;
  trialLoading.value = true;
  try {
    trialPlan.value = await fetchTrialPlan(row.studentId);
  } catch {
    // 错误提示由统一拦截器给出（如「不是从咨询同步进来的」）
    trialVisible.value = false;
  } finally {
    trialLoading.value = false;
  }
}

async function doTrialSupplement() {
  if (!trialRow.value) return;
  trialSaving.value = true;
  try {
    const r = await trialSupplement(trialRow.value.studentId);
    ElMessage.success(r ? '已发起补费，待财务确认到账后自动转为正式在读' : '已发起补费');
    trialVisible.value = false;
    load(query.page);
  } catch {
    // 统一提示
  } finally {
    trialSaving.value = false;
  }
}

function openTrialQuit(row: StudentRow) {
  quitRow.value = row;
  quitForm.applyReason = '';
  quitForm.effectDate = new Date().toISOString().slice(0, 10);
  quitVisible.value = true;
}

async function doTrialQuit() {
  if (!quitRow.value) return;
  if (!quitForm.applyReason.trim()) {
    ElMessage.warning('请填写退学原因');
    return;
  }
  quitSaving.value = true;
  try {
    const r = await trialQuit({
      studentId: quitRow.value.studentId,
      applyReason: quitForm.applyReason.trim(),
      effectDate: quitForm.effectDate || null,
    });
    ElMessage.success(`退学申请已提交（${r?.applyNo || ''}），等待学管审批`);
    quitVisible.value = false;
    load(query.page);
  } catch {
    // 统一提示
  } finally {
    quitSaving.value = false;
  }
}
</script>

<style scoped>
.tsv-tip {
  margin-bottom: 10px;
}
.tsv-cards {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.tsv-card {
  min-width: 120px;
  padding: 8px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-blank);
}
.tsv-card__k {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.tsv-card__v {
  font-size: 20px;
  font-weight: 600;
}
.tsv-card__v.ok {
  color: var(--el-color-success);
}
.tsv-card__v.warn {
  color: var(--el-color-warning);
}
.tsv-card__v.danger {
  color: var(--el-color-danger);
}
.tsv-filter {
  margin-bottom: 8px;
}
.tsv-page {
  margin-top: 10px;
  justify-content: flex-end;
}
.tsv-sec {
  margin-top: 12px;
}
.tsv-dhead {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.tsv-sub {
  font-weight: 600;
  font-size: 13px;
  border-left: 3px solid var(--el-color-primary);
  padding-left: 8px;
  margin: 10px 0 8px;
}

/* 缴费记录签（2026-10-21 新增） */
.tsv-pay-sum {
  font-size: 13px;
  padding: 6px 10px;
  margin-bottom: 8px;
  background: var(--el-fill-color-light, #f5f7fa);
  border-radius: 4px;
}
.tsv-pay-sum b {
  color: var(--el-color-danger, #f56c6c);
}
.tsv-pay :deep(.el-collapse-item__header) {
  display: flex;
  gap: 12px;
  font-size: 13px;
}
.tsv-pay-title {
  font-weight: 600;
  min-width: 130px;
}
.tsv-pay-meta {
  color: var(--el-text-color-secondary, #909399);
  font-size: 12px;
}
.tsv-pay-empty {
  padding: 10px 0;
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

/* ★ 2026-10-20 升云弹窗 */
.upg-tip {
  margin-bottom: 10px;
}
.upg-body {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.upg-main {
  flex: 1;
  min-width: 0;
}
.upg-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
/* ★ 2026-10-20 批注：表格左下角「全选本页」+ 右下角翻页 */
.upg-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}
.upg-pager {
  margin-left: auto;
}
/* ⚠️ Element Plus 默认的勾选框边框是 #E1E6EF（白底上几乎看不见，截图里像没渲染），
   升云弹窗全靠勾选选人，这里加深一档 */
.upg-body :deep(.el-checkbox__inner),
.upg-foot :deep(.el-checkbox__inner) {
  border-color: #a9b0bd;
}
.upg-body :deep(.el-table__header .el-checkbox__inner) {
  border-color: #a9b0bd;
}
.upg-side {
  width: 300px;
  flex: none;
  border-left: 1px solid var(--el-border-color-lighter);
  padding-left: 14px;
}
.upg-side__t {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
}
.upg-target {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
  font-size: 12px;
  line-height: 1.9;
  color: var(--el-text-color-regular);
}
.upg-target--empty {
  color: var(--el-text-color-secondary);
}
.upg-picked {  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 40px;
  max-height: 180px;
  overflow-y: auto;
}
.upg-remark {
  margin-top: 12px;
}
.tsv-upg-rec {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
  font-size: 13px;
}

/* ★ 2026-10-20 试学闭环弹窗 */
.trial-alert {
  margin-bottom: 10px;
}
.trial-missing {
  color: var(--el-color-danger);
}
</style>
