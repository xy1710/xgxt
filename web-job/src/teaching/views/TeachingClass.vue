<template>
  <div class="tcv">
    <!-- 说明条 -->
    <el-alert class="tcv-tip" type="info" :closable="false" show-icon>
      <template #title>
        本页合并了 <b>4 个部门</b>的班级信息（初高部 / 大学部 / 实训 / 就业部）。
        <span class="muted">
          班级状态码三套一致（1 开放 / 2 封班 / 4 已结业）；
          但「班级编号」「结业日期」只有实训有，「今日出勤率」只有初高有 —— 表单会按部门自动隐藏不适用的字段。
        </span>
      </template>
    </el-alert>

    <!-- 统计卡片（多学段时按学段分行） -->
    <div class="tcv-cards">
      <div v-for="s in summary" :key="s.stage" class="tcv-card">
        <div class="tcv-card__k">{{ s.stageName }}班级</div>
        <div class="tcv-card__v">{{ s.total }}</div>
        <div class="tcv-card__x">
          <span class="ok">开放 {{ s.openCount }}</span>
          <span>封班 {{ s.closedCount }}</span>
          <span class="danger">已结业 {{ s.graduatedCount }}</span>
        </div>
        <div class="tcv-card__x">在班学生 {{ s.studentCount }} 人</div>
      </div>
      <div v-if="!summary.length" class="tcv-card">
        <div class="tcv-card__k">暂无数据</div>
        <div class="tcv-card__v">0</div>
      </div>
    </div>

    <!-- 筛选 -->
    <el-form class="tcv-filter" inline>
      <!-- 2026-10-16 按批注：原「学段」筛选改名「部门」（选项 = 初高部 / 大学部 / 实训）。
           原来紧挨着的那个 deptCode「部门」下拉是**没接上接口的死筛选**
           （query.deptCode 既没进查询参数、也没进 load），批注口径下两者重名，
           这里把死掉的那个删掉，只留一个真正生效的。 -->
      <el-form-item label="部门">
        <el-select v-model="query.stage" clearable placeholder="全部部门" style="width: 130px" @change="onStageChange">
          <el-option v-for="s in stageOptions" :key="s.value" :label="s.label" :value="s.value" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="phaseOptions.length" label="阶段">
        <el-select v-model="query.phaseCode" clearable placeholder="全部" style="width: 140px" @change="load(1)">
          <el-option v-for="p in phaseOptions" :key="p.value" :label="p.label" :value="p.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="状态">
        <el-select v-model="query.classStatus" clearable placeholder="全部" style="width: 120px" @change="load(1)">
          <!-- 2026-10-19 批注：删除「待结业」选项 -->
          <el-option v-for="s in CLASS_STATUS_SELECTABLE" :key="s.value" :label="s.label" :value="s.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="关键字">
        <el-input
          v-model="query.keyword"
          placeholder="班级名 / 编号 / 班主任"
          clearable
          style="width: 180px"
          @keyup.enter="load(1)"
        />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="load(1)">查询</el-button>
        <el-button @click="reset">重置</el-button>
        <el-button v-if="!isReadOnlyUser" type="success" @click="openCreate">新增班级</el-button>
      </el-form-item>
    </el-form>

    <!-- 列表 -->
    <!-- ★ 列宽纪律：内容大多只有 2~4 个字，一律用 min-width 让浏览器按需收缩/伸展，
         不要拍固定 width —— 之前 17 列固定宽度合计约 1800px，屏幕装不下，
         每列一大片空白（学生档案页 12 列约 1215px，是对照基准）。 -->
    <el-table v-loading="loading" :data="rows" border stripe size="small">
      <!-- 2026-10-16：原来「学段」与「部门」是两列（部门列取 row.deptName），
           批注口径下重名，合并成一列 —— 取部门名，没部门就退回学段名 -->
      <el-table-column v-if="!query.stage" label="部门" width="70" align="center">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ row.deptName || row.stageName }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="班级名称" min-width="110">
        <template #default="{ row }">
          <a class="link" @click="openDetail(row)">{{ row.className }}</a>
        </template>
      </el-table-column>
      <!-- ★ 只有实训有这一列 -->
      <el-table-column v-if="hasClassCodeCol" label="班级编号" min-width="105">
        <template #default="{ row }">{{ row.classCode || '—' }}</template>
      </el-table-column>
      <!-- ★ 阶段回显：优先「方案里的阶段名」，老班级退回阶段码名称（见 phaseTextOf） -->
      <el-table-column label="阶段" min-width="90" align="center">
        <template #default="{ row }">{{ phaseTextOf(row) }}</template>
      </el-table-column>
      <el-table-column label="班主任" min-width="70">
        <template #default="{ row }">{{ row.headTeacherName || '—' }}</template>
      </el-table-column>
      <el-table-column label="教员" min-width="70">
        <template #default="{ row }">{{ row.teacherName || '—' }}</template>
      </el-table-column>
      <el-table-column label="助教" min-width="70">
        <template #default="{ row }">{{ row.assistantName || '—' }}</template>
      </el-table-column>
      <!-- ★ 只有大学/实训有交棒岗位（初高没有） -->
      <el-table-column v-if="!query.stage || query.stage !== 'jh'" label="项目经理" min-width="80">
        <template #default="{ row }">{{ row.projectManagerName || '—' }}</template>
      </el-table-column>
      <el-table-column v-if="!query.stage || query.stage !== 'jh'" label="就业老师" min-width="80">
        <template #default="{ row }">{{ row.employmentTeacherName || '—' }}</template>
      </el-table-column>
      <el-table-column label="人数" width="55" align="center">
        <template #default="{ row }">
          <b>{{ row.studentCount }}</b>
        </template>
      </el-table-column>
      <!-- ★ 列头按学段口径动态改字：初高是「今日」出勤率，别写成「出勤率」 -->
      <el-table-column :label="rateLabel" min-width="92" align="center">
        <template #default="{ row }">
          <span v-if="row.attendanceRate === null">—</span>
          <span v-else :class="rateClass(row)">{{ row.attendanceRate }}%</span>
        </template>
      </el-table-column>
      <el-table-column label="教室" min-width="95">
        <template #default="{ row }">{{ row.classroom || '—' }}</template>
      </el-table-column>
      <el-table-column label="开班日期" min-width="100" align="center">
        <template #default="{ row }">{{ row.openDate || '—' }}</template>
      </el-table-column>
      <!-- ★ 只有实训有结业日期 -->
      <el-table-column v-if="hasCloseDateCol" label="结业日期" min-width="100" align="center">
        <template #default="{ row }">{{ row.closeDate || '—' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="70" align="center">
        <template #default="{ row }">
          <el-tag :type="tagType(row.classStatus)" size="small">{{ row.classStatusName }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="280" fixed="right" align="center">
        <template #default="{ row }">
          <!-- 2026-10-19 批注：按钮「花名册」改名「详情」（抽屉里不只有名单，还有班级信息与交接记录） -->
          <el-button link type="primary" @click="openDetail(row)">详情</el-button>
          <el-button v-if="!isReadOnlyUser" link type="primary" @click="openEdit(row)">编辑</el-button>
          <!-- 2026-10-19 批注：操作列加【交接】；原来单独的【改状态】移进编辑弹窗 -->
          <el-button v-if="!isReadOnlyUser" link type="success" @click="openHandover(row)">交接</el-button>
          <!-- 2026-10-20 批注：交接后面加【升实训】（只对大学部班级开放） -->
          <el-button
            v-if="!isReadOnlyUser && row.stage === 'class'"
            link
            type="warning"
            @click="openTraining(row)"
          >
            升实训
          </el-button>
          <el-button v-if="!isReadOnlyUser" link type="danger" @click="doDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="tcv-page"
      layout="total, sizes, prev, pager, next"
      :total="total"
      :current-page="query.page"
      :page-size="query.size"
      :page-sizes="[10, 20, 50, 100]"
      @current-change="load"
      @size-change="load(1)"
    />

    <!-- ============ 详情（原「花名册」，2026-10-19 改名） ============ -->
    <el-drawer v-model="detailVisible" :title="`${detail?.base.className || ''} · 详情`" size="560px">
      <template v-if="detail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="部门">{{ detail.base.stageName }}</el-descriptions-item>
          <el-descriptions-item label="班级名称">{{ detail.base.className }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.base.classCode" label="班级编号">
            {{ detail.base.classCode }}
          </el-descriptions-item>
          <el-descriptions-item label="阶段">{{ phaseTextOf(detail.base) }}</el-descriptions-item>
          <el-descriptions-item label="班主任">{{ detail.base.headTeacherName || '—' }}</el-descriptions-item>
          <el-descriptions-item label="教员">{{ detail.base.teacherName || '—' }}</el-descriptions-item>
          <el-descriptions-item label="助教">{{ detail.base.assistantName || '—' }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.base.projectManagerName" label="项目经理">
            {{ detail.base.projectManagerName }}
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.base.employmentTeacherName" label="就业老师">
            {{ detail.base.employmentTeacherName }}
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.base.universityNo" label="大学学号">
            {{ detail.base.universityNo }}
          </el-descriptions-item>
          <el-descriptions-item :label="detail.base.stage === 'job' ? '教室地点' : '教室'">
            {{ detail.base.classroom || '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="开班日期">{{ detail.base.openDate || '—' }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.base.closeDate" label="结业日期">
            {{ detail.base.closeDate }}
          </el-descriptions-item>
          <el-descriptions-item label="在班人数">{{ detail.base.studentCount }}</el-descriptions-item>
          <el-descriptions-item :label="detail.base.attendanceRateKind === 'today' ? '今日出勤率' : '累计出勤率'">
            {{ detail.base.attendanceRate === null ? '—' : `${detail.base.attendanceRate}%` }}
          </el-descriptions-item>
          <el-descriptions-item label="班级状态">
            <el-tag :type="tagType(detail.base.classStatus)" size="small">
              {{ detail.base.classStatusName }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>

        <el-divider content-position="left">花名册（{{ detail.roster.length }} 人）</el-divider>
        <el-table :data="detail.roster" border size="small" max-height="420">
          <el-table-column label="学号" width="110">
            <template #default="{ row }">{{ row.studentNo || '—' }}</template>
          </el-table-column>
          <el-table-column label="姓名" width="100">
            <template #default="{ row }">{{ row.studentName || '—' }}</template>
          </el-table-column>
          <el-table-column label="性别" width="60" align="center">
            <template #default="{ row }">{{ row.genderName || '—' }}</template>
          </el-table-column>
          <!-- ★ 只有实训有独立花名册表，才有入班方式 -->
          <el-table-column v-if="detail.base.stage === 'job'" label="入班方式" width="100">
            <template #default="{ row }">{{ row.joinTypeName || '—' }}</template>
          </el-table-column>
          <el-table-column label="入班日期" width="110" align="center">
            <template #default="{ row }">{{ row.joinDate || '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="80" align="center">
            <template #default="{ row }">{{ row.inClassStatusName || '—' }}</template>
          </el-table-column>
        </el-table>

        <!-- 2026-10-19 批注：交接记录同步到班级详情（按时间倒序，只列真正换了人的岗位） -->
        <el-divider content-position="left">交接记录（{{ detailHandovers.length }}）</el-divider>
        <el-empty v-if="!detailHandovers.length" description="暂无交接记录" :image-size="56" />
        <el-table v-else :data="detailHandovers" border size="small">
          <el-table-column label="交接日期" width="95" align="center">
            <template #default="{ row }">{{ row.handoverDate || '—' }}</template>
          </el-table-column>
          <el-table-column label="岗位变更" min-width="230">
            <template #default="{ row }">
              <div v-for="c in handoverChanges(row)" :key="c.role" class="ho-line">
                <span class="ho-role">{{ c.role }}</span>
                <span class="ho-old">{{ c.from || '（空白）' }}</span>
                <span class="ho-arrow">→</span>
                <span class="ho-new">{{ c.to || '（空白）' }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="原因" width="130" show-overflow-tooltip>
            <template #default="{ row }">{{ row.reason || '—' }}</template>
          </el-table-column>
          <el-table-column label="操作人" width="70" align="center">
            <template #default="{ row }">{{ row.operatorName || '—' }}</template>
          </el-table-column>
        </el-table>
      </template>
    </el-drawer>

    <!-- ============ 新增 / 编辑 ============ -->
    <el-dialog
      v-model="editVisible"
      :title="form.id ? '编辑班级' : '新增班级'"
      width="900px"
      top="6vh"
      destroy-on-close
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-row :gutter="12">
          <!-- 2026-10-15 按批注：删除「学段」选择器，学段由「部门」自动判定
               （初高部 → 初高；大学部 → 大学；实训从实训页签进入仍可新增） -->
          <el-col :span="8">
            <el-form-item label="班级名称">
              <el-input v-model="form.className" maxlength="50" placeholder="留空自动生成占位名" />
            </el-form-item>
          </el-col>
          <!-- ★ 2026-10-21 用户口径：班级编号三部门统一（初高部/大学部/就业部），必填 -->
          <!-- ★ 2026-10-22 用户口径：去掉「生成」按钮，一律由相关人员手工填写 -->
          <el-col :span="8">
            <el-form-item label="班级编号" prop="classCode">
              <el-input v-model="form.classCode" maxlength="32" placeholder="Q17/J101/T101" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="部门">
              <el-select v-model="form.deptCode" style="width: 100%" @change="onFormDeptChange">
                <el-option v-for="d in DEPT_OPTIONS" :key="d.value" :label="d.label" :value="d.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <!-- ★ 2026-10-16：阶段方案（选项按「部门」过滤；在 系统设置 · 阶段方案 页维护） -->
          <el-col :span="8">
            <el-form-item label="阶段方案">
              <el-select
                v-model="form.schemeId"
                clearable
                placeholder="请选择方案"
                style="width: 100%"
                @change="onSchemeChange"
              >
                <el-option v-for="s in formSchemeOptions" :key="s.id" :label="s.schemeName" :value="s.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <!-- ★ 选了方案 → 阶段选项 = 方案里的阶段；没选方案 → 退回老的阶段选项（历史数据仍可编辑） -->
          <el-col v-if="form.schemeId || formPhaseOptions.length" :span="8">
            <el-form-item label="阶段">
              <el-select
                v-if="form.schemeId"
                v-model="form.schemeStageId"
                clearable
                placeholder="请选择阶段"
                style="width: 100%"
                @change="onSchemeStageChange"
              >
                <!-- 选中后只显示阶段名称（宽度有限）；下拉里带一列灰字「学制X月」 -->
                <el-option v-for="p in formSchemeStageOptions" :key="p.id" :label="p.stageName" :value="p.id">
                  <span>{{ p.stageName }}</span>
                  <span v-if="p.studyMonths" class="stage-months">学制{{ p.studyMonths }}月</span>
                </el-option>
              </el-select>
              <el-select v-else v-model="form.phaseCode" clearable placeholder="请选择" style="width: 100%">
                <el-option v-for="p in formPhaseOptions" :key="p.value" :label="p.label" :value="p.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <!-- 2026-10-19 批注：原来的操作列【改状态】移到编辑弹窗里；
               「待结业」已删除，封班后直接选「已结业」。已结业是终态，下拉禁用。 -->
          <el-col v-if="form.id" :span="8">
            <el-form-item label="班级状态">
              <el-select
                v-model="form.classStatus"
                style="width: 100%"
                :disabled="editStatusFrom === 4"
              >
                <el-option v-for="s in editStatusOptions" :key="s.value" :label="s.label" :value="s.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <!-- 2026-10-15 改版：删除「班主任/教员/助教」工号/ID 输入框，
               姓名字段直接接入权限管理的用户列表，下拉选择（选人自动带 ID） -->
          <el-col :span="8">
            <el-form-item label="班主任姓名">
              <el-select
                v-model="form.headTeacherId"
                clearable
                filterable
                placeholder="接入权限管理，请选择"
                :loading="staffLoading"
                style="width: 100%"
                @change="onStaffChange('headTeacher', $event)"
              >
                <el-option
                  v-for="u in withFallback(staffOptions, form.headTeacherId, form.headTeacherName)"
                  :key="u.id"
                  :label="u.userName"
                  :value="u.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="教员姓名">
              <el-select
                v-model="form.teacherId"
                clearable
                filterable
                placeholder="接入权限管理，请选择"
                :loading="staffLoading"
                style="width: 100%"
                @change="onStaffChange('teacher', $event)"
              >
                <el-option
                  v-for="u in withFallback(staffOptions, form.teacherId, form.teacherName)"
                  :key="u.id"
                  :label="u.userName"
                  :value="u.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="助教姓名">
              <el-select
                v-model="form.assistantId"
                clearable
                filterable
                placeholder="接入权限管理，请选择"
                :loading="staffLoading"
                style="width: 100%"
                @change="onStaffChange('assistant', $event)"
              >
                <el-option
                  v-for="u in withFallback(staffOptions, form.assistantId, form.assistantName)"
                  :key="u.id"
                  :label="u.userName"
                  :value="u.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <!-- 2026-10-16 按批注：加回「项目经理姓名 / 就业老师姓名」——不再是工号/ID 输入框，
               而是和 班主任/教员/助教 同一套规则：下拉取自「权限管理」用户列表，选人自动带 ID。
               ★ 只有「阶段 = 实训」时才必填（见 isTrainPhase / rules）。
               ⚠️ 初高部的表没有这几列，所以只对 大学部 / 实训 显示（与「大学学号」下线的口径一致）。 -->
          <template v-if="form.stage !== 'jh'">
            <el-col :span="8">
              <el-form-item label="项目经理姓名" prop="projectManagerName">
                <el-select
                  v-model="form.projectManagerId"
                  clearable
                  filterable
                  placeholder="接入权限管理，请选择"
                  :loading="staffLoading"
                  style="width: 100%"
                  @change="onStaffChange('projectManager', $event)"
                >
                  <el-option
                    v-for="u in withFallback(staffOptions, form.projectManagerId, form.projectManagerName)"
                    :key="u.id"
                    :label="u.userName"
                    :value="u.id"
                  />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="就业老师姓名" prop="employmentTeacherName">
                <el-select
                  v-model="form.employmentTeacherId"
                  clearable
                  filterable
                  placeholder="接入权限管理，请选择"
                  :loading="staffLoading"
                  style="width: 100%"
                  @change="onStaffChange('employmentTeacher', $event)"
                >
                  <el-option
                    v-for="u in withFallback(staffOptions, form.employmentTeacherId, form.employmentTeacherName)"
                    :key="u.id"
                    :label="u.userName"
                    :value="u.id"
                  />
                </el-select>
              </el-form-item>
            </el-col>
          </template>
          <!-- 2026-10-19 批注：教室按「楼栋-房间号」规定格式输出，例如 A-201。
               输入宽容（A栋-102 / 教学楼 A-102 / a102 都能写），失焦即归一；
               认不出来的格式保存时会被拦下并提示正确写法。 -->
          <el-col :span="8">
            <el-form-item :label="curMeta?.classroomLabel || '教室'" prop="classroom">
              <el-input
                v-model="form.classroom"
                :placeholder="`例如：${CLASSROOM_EXAMPLE}`"
                maxlength="20"
                clearable
                @blur="onClassroomBlur"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="开班日期">
              <el-date-picker v-model="form.openDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <!-- ★ 只有实训有结业日期 -->
          <el-col v-if="curMeta?.hasCloseDate" :span="8">
            <el-form-item label="结业日期">
              <el-date-picker v-model="form.closeDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <!-- ★ 大学那张表没有 remark 列 -->
          <el-col v-if="form.stage !== 'class'" :span="24">
            <el-form-item label="备注">
              <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="500" show-word-limit />
            </el-form-item>
          </el-col>
        </el-row>

        <el-alert
          v-if="form.stage === 'job'"
          type="info"
          :closable="false"
          show-icon
          title="实训班新建时默认「封班」状态 —— 能进实训/就业阶段的班级只会是封班，「开放」已废弃"
        />
        <el-alert
          v-if="form.stage === 'class'"
          type="info"
          :closable="false"
          show-icon
          title="大学班级没有「班级编号」也没有「备注」字段（那两张表里就没这两列），改动不会生效"
        />
        <el-alert
          v-if="form.stage === 'jh'"
          type="info"
          :closable="false"
          show-icon
          title="班主任 / 教员 / 助教 均为可选，姓名来自「权限管理」的用户列表；初高部的表没有「项目经理姓名 / 就业老师姓名 / 大学学号」这几列，所以这个学段不显示"
        />
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doSave">保存</el-button>
      </template>
    </el-dialog>

    <!-- ============ 班级交接（2026-10-19 批注） ============ -->
    <el-dialog v-model="handoverVisible" title="班级交接" width="860px" top="6vh" destroy-on-close>
      <el-form label-width="110px">
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="班级名称">
              <el-input :model-value="handoverForm.className" disabled />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="交接日期">
              <el-date-picker
                v-model="handoverForm.handoverDate"
                type="date"
                value-format="YYYY-MM-DD"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <!-- 原负责人 = 班级当前值（没人的默认空白）；新负责人从「权限管理」用户列表选，
             留空 = 该岗位不换人。 -->
        <el-table :data="handoverRoles" border size="small">
          <el-table-column label="岗位" width="110" align="center">
            <template #default="{ row }">{{ row.label }}</template>
          </el-table-column>
          <el-table-column label="原负责人" width="180">
            <template #default="{ row }">
              <span :class="{ 'ho-empty': !row.oldName }">{{ row.oldName || '（空白）' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="新负责人">
            <template #default="{ row }">
              <el-select
                v-model="row.newId"
                clearable
                filterable
                placeholder="不换则留空"
                :loading="staffLoading"
                style="width: 100%"
                @change="onHandoverPick(row)"
              >
                <el-option v-for="u in staffOptions" :key="u.id" :label="u.userName" :value="u.id" />
              </el-select>
            </template>
          </el-table-column>
        </el-table>

        <el-form-item label="交接原因" class="ho-reason">
          <el-input
            v-model="handoverForm.reason"
            type="textarea"
            :rows="2"
            maxlength="255"
            show-word-limit
            placeholder="例如：原班主任调岗，由李老师接任"
          />
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="提交后立即生效：班级负责人更新为「新负责人」，并在班级详情的「交接记录」里留一条快照。"
      />
      <template #footer>
        <el-button @click="handoverVisible = false">取消</el-button>
        <el-button type="primary" :loading="handoverSaving" @click="doHandover">确认交接</el-button>
      </template>
    </el-dialog>

    <!-- ============ 升实训（2026-10-20 批注：大学部 → 就业部） ============ -->
    <el-dialog v-model="trainingVisible" title="升实训（大学部 → 就业部）" width="720px" top="7vh" destroy-on-close>
      <el-alert class="tv-tip" type="warning" :closable="false" show-icon>
        <template #title>
          升实训会把这个班<b>连同学生</b>整体转到就业部：新班<b>不再有班主任 / 教员 / 助教</b>，
          只保留项目经理与就业老师；原班级从大学部移除。学生状态统一变为「实训中」。
        </template>
      </el-alert>
      <el-form label-width="100px" class="tv-form">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="原班级">
              <el-input :model-value="trainingForm.srcName" disabled />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="部门">
              <el-input model-value="就业部" disabled />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="班级名称">
              <el-input v-model="trainingForm.className" maxlength="50" placeholder="默认沿用原班级名称，可修改" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="阶段">
              <el-select v-model="trainingForm.phaseCode" placeholder="就业部阶段方案" style="width: 100%">
                <el-option v-for="p in trainingPhaseOptions" :key="p.value" :label="p.label" :value="p.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="项目经理">
              <el-select
                v-model="trainingForm.projectManagerId"
                filterable
                placeholder="请选择"
                :loading="staffLoading"
                style="width: 100%"
              >
                <el-option v-for="u in staffOptions" :key="u.id" :label="u.userName" :value="u.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="就业老师">
              <el-select
                v-model="trainingForm.employmentTeacherId"
                filterable
                placeholder="请选择"
                :loading="staffLoading"
                style="width: 100%"
              >
                <el-option v-for="u in staffOptions" :key="u.id" :label="u.userName" :value="u.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="备注">
              <el-input
                v-model="trainingForm.remark"
                type="textarea"
                :rows="2"
                maxlength="200"
                show-word-limit
                :placeholder="`默认记录：由大学部「${trainingForm.srcName}」升实训`"
              />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        :title="`提交后：「${trainingForm.srcName}」的 ${trainingForm.studentCount} 名学生整体升入「${trainingForm.className || trainingForm.srcName}」，原班级从大学部移除。`"
      />
      <template #footer>
        <el-button @click="trainingVisible = false">取消</el-button>
        <el-button type="primary" :loading="trainingSaving" @click="doTrainingUpgrade">确认升实训</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 统一班级信息页（第 2 期 · 第七个合并的业务域）
 * ============================================================
 * 合并了 3 个学段（初高 / 大学 / 实训）的班级管理：
 *   · 一个页面 + 学段筛选（不再 3 个页面各一套）
 *   · 「班级编号 / 结业日期 / 交棒岗位 / 备注」按学段自动显隐
 *     —— 由后端 /meta 下发的 hasClassCode / hasCloseDate 决定，**不写死学段判断**
 *   · 状态机统一（1 开放 / 2 封班 / 4 已结业；2026-10-19 起「待结业」下线），非法流转后端会拦
 *
 * 【★ 与学生档案页最大的不同：不按名字去重】
 *   「初高 G104」和「大学 G104」是两个不同的班，同名是常态。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useBreadcrumbStageKey } from '@/store/breadcrumb';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { isReadOnlyUser } from '@/store/permission';
import { visibleStageOptions } from '@/teaching/access';
import { DeptCode } from 'shared-types';
import { userApi } from '@/perm/api/perm';
import type { PermUserListItem } from 'shared-types/perm';
import {
  listClasses,
  getClassDetail,
  saveClass,
  deleteClass,
  getClassMeta,
  getClassSummary,
  getSchemeOptions,
  listClassHandovers,
  doClassHandover,
  upgradeClassToTraining,
  CLASS_STATUS_TAG,
  CLASS_STATUS_SELECTABLE,
  classStatusOptions,
  CLASS_STAGES,
  DEPT_OPTIONS,
  type ClassDetail,
  type ClassHandoverPayload,
  type ClassHandoverRow,
  type ClassRow,
  type ClassSaveBody,
  type ClassStage,
  type ClassStageMeta,
  type ClassSummary,
  type SchemeOption,
  type StagePlanOption,
} from '@/teaching/api/class';
// 教室「楼栋-房间号」格式：归一 + 校验（前后端同一套规则，见文件头注释）
import {
  CLASSROOM_EXAMPLE,
  CLASSROOM_TIP,
  isClassroomValid,
  normalizeClassroom,
} from '@/teaching/classroom';

/* ---------------- 学段可见性（第 3 期：判权不再依赖旧路由） ---------------- */
// ★ 2026-10-22 部门口径统一：对外只有「初高中 / 大学部 / 就业部」三个部门。
//   「实训」是就业部下的一个阶段（班级 dept_code=3），不是并列部门。
const STAGE_LABEL: Record<ClassStage, string> = {
  jh: '初高部',
  class: '大学部',
  job: '就业部',
  // ★ 2026-10-19 批注：就业部（独立学段）
  emp: '就业部',
};

const stageOptions = computed(() => visibleStageOptions('class', CLASS_STAGES, STAGE_LABEL));

/* ---------------- 列表 ---------------- */
const loading = ref(false);
const rows = ref<ClassRow[]>([]);
const total = ref(0);
const summary = ref<ClassSummary[]>([]);
const metaList = ref<ClassStageMeta[]>([]);

const query = reactive({
  // 「部门」筛选复用 stage：初高部 = jh、大学部 = class、实训 = job
  stage: undefined as ClassStage | undefined,
  classStatus: undefined as number | undefined,
  phaseCode: undefined as number | undefined,
  keyword: '',
  page: 1,
  size: 20,
});

/* 面包屑第 4 级：当前正在查看的学段（筛选器变化时自动同步，页面卸载自动清空） */
useBreadcrumbStageKey(() => query.stage || '');

/** 当前所选学段的 meta（列显隐/标签都靠它） */
const curMeta = computed(() => metaList.value.find((m) => m.stage === query.stage) || null);
const phaseOptions = computed(() => curMeta.value?.phaseOptions || []);

/** 未选学段时，只要任一可见学段有编号/结业日期就显示该列 */
const hasClassCodeCol = computed(() =>
  query.stage ? !!curMeta.value?.hasClassCode : metaList.value.some((m) => m.hasClassCode),
);
const hasCloseDateCol = computed(() =>
  query.stage ? !!curMeta.value?.hasCloseDate : metaList.value.some((m) => m.hasCloseDate),
);

/**
 * ★ 出勤率列头必须随口径变：初高是「今日出勤率」，大学/实训是「累计出勤率」。
 *   混着写会被读成同一种指标 —— 今日 92% 和累计 92% 完全不是一回事。
 *   （判断依据直接用初高这个固定事实，不去猜 meta 的其它标志位。）
 */
const rateLabel = computed(() => {
  if (!query.stage) return '出勤率';
  return query.stage === 'jh' ? '今日出勤率' : '累计出勤率';
});

function rateClass(row: ClassRow): string {
  if (row.attendanceRate === null) return '';
  if (row.attendanceRate < 90) return 'danger';
  if (row.attendanceRate < 95) return 'warn';
  return 'ok';
}

function tagType(s: number): string {
  return (CLASS_STATUS_TAG[s] || 'info') as never;
}

async function load(page?: number) {
  if (page) query.page = page;
  loading.value = true;
  try {
    const [r, s, m] = await Promise.all([
      listClasses({ ...query }),
      getClassSummary({ ...query }),
      metaList.value.length ? Promise.resolve(metaList.value) : getClassMeta(),
    ]);
    rows.value = r.list || [];
    total.value = r.total || 0;
    summary.value = s || [];
    metaList.value = m || [];
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

/** 切学段：阶段码和状态都是学段内的，必须清掉，否则会带着上一个学段的筛选去查 */
function onStageChange() {
  query.phaseCode = undefined;
  query.classStatus = undefined;
  load(1);
}

function reset() {
  query.stage = undefined;
  query.classStatus = undefined;
  query.phaseCode = undefined;
  query.keyword = '';
  load(1);
}

/* ---------------- 详情 / 花名册 ---------------- */
const detailVisible = ref(false);
const detail = ref<ClassDetail | null>(null);
/** 2026-10-19 批注：详情抽屉里同步展示交接记录 */
const detailHandovers = ref<ClassHandoverRow[]>([]);

async function openDetail(row: ClassRow) {
  detail.value = await getClassDetail(row.stage, row.classId);
  // 交接记录失败不阻塞花名册（例如公共库暂时连不上）
  detailHandovers.value = await listClassHandovers(row.stage, row.classId).catch(() => []);
  detailVisible.value = true;
}

/** 一条交接记录 →「只列真正换了人的岗位」，详情抽屉太窄，没变的不占行 */
function handoverChanges(row: ClassHandoverRow): Array<{ role: string; from: string; to: string }> {
  const all = [
    { role: '班主任', slot: row.headTeacher },
    { role: '教员', slot: row.teacher },
    { role: '助教', slot: row.assistant },
    { role: '项目经理', slot: row.projectManager },
    { role: '就业老师', slot: row.employmentTeacher },
  ];
  return all
    .filter((x) => (x.slot.oldId || '') !== (x.slot.newId || '') || (x.slot.oldName || '') !== (x.slot.newName || ''))
    .map((x) => ({ role: x.role, from: x.slot.oldName || '', to: x.slot.newName || '' }));
}

/* ---------------- 新增 / 编辑 ---------------- */
const editVisible = ref(false);
const saving = ref(false);
const formRef = ref<FormInstance>();

/** 阶段码里的「实训」：班级/学生两边的阶段表都用 13 = 实训 */
const TRAIN_PHASE_CODE = 13;
/** 是否处于「实训」阶段 —— 决定「项目经理姓名 / 就业老师姓名」要不要必填 */
const isTrainPhase = computed(() => Number(form.phaseCode) === TRAIN_PHASE_CODE);

/**
 * 表单校验规则
 *   2026-10-15 改版：学段 / 班级名称 / 部门 / 班主任 / 教员 / 阶段 全部不再必填；
 *   2026-10-16 批注：「项目经理姓名 / 就业老师姓名」**只在阶段 = 实训时**必填。
 *   规则写成 computed，切换阶段后红星与校验会立刻跟着变。
 */
const rules = computed<FormRules>(() => ({
  // ★ 2026-10-21：班级编号三部门统一必填（历史班级留空，首次编辑时补）
  classCode: [
    { required: true, message: '请填写班级编号，如 Q17 / J101 / T101', trigger: 'blur' },
    {
      validator: (_rule, value, callback) => {
        if (String(value ?? '').trim()) callback();
        else callback(new Error('请填写班级编号，如 Q17 / J101 / T101'));
      },
      trigger: 'submit',
    },
  ],
  projectManagerName: isTrainPhase.value
    ? [{ required: true, message: '实训阶段必填', trigger: 'change' }]
    : [],
  employmentTeacherName: isTrainPhase.value
    ? [{ required: true, message: '实训阶段必填', trigger: 'change' }]
    : [],
  /**
   * 2026-10-19 批注：教室必须输出成「楼栋-房间号」，例如 A-201。
   * 校验看的是**归一后**的值 —— 输入 A栋-102 / 教学楼 A-102 也算合规（失焦时会自动改成 A-102），
   * 只有认不出来的写法（比如只写 102、带中文描述的一串）才会被拦。
   */
  classroom: [
    {
      validator: (_rule, value, callback) => {
        if (isClassroomValid(value)) callback();
        else callback(new Error(CLASSROOM_TIP));
      },
      trigger: 'blur',
    },
  ],
}));

/** 教室失焦即归一：A栋-102 / 教学楼 A-102 / a102 → A-102（不改变语义，只统一写法） */
function onClassroomBlur() {
  form.classroom = normalizeClassroom(form.classroom);
}

function emptyForm(stage: ClassStage): ClassSaveBody {
  return {
    stage,
    className: '',
    classCode: '',
    // 2026-10-19：实训与就业部都归「就业部」(3)，两者只靠学段区分
    deptCode: stage === 'jh' ? 1 : stage === 'class' ? 2 : 3,
    phaseCode: undefined,
    // ★ 2026-10-16：阶段方案（null = 未选，老班级/不选方案时为 null）
    schemeId: null,
    schemeStageId: null,
    schemeStageName: null,
    headTeacherId: '',
    headTeacherName: '',
    teacherId: '',
    teacherName: '',
    assistantId: '',
    assistantName: '',
    projectManagerId: '',
    projectManagerName: '',
    employmentTeacherId: '',
    employmentTeacherName: '',
    universityNo: '',
    classroom: '',
    openDate: '',
    closeDate: '',
    remark: '',
  };
}
const form = reactive<ClassSaveBody>(emptyForm('jh'));

/** 表单里的阶段选项：★ 2026-10-16 改为「方案驱动」——
 *   选了方案 → 只给该方案下的阶段（新方案里的新阶段也能选到）；
 *   没选方案 → 回落到 meta 的阶段清单（此时初高仍按旧口径过滤掉预科）。 */
const JH_PHASE_CODES = [102, 103, 104, 105, 106, 107];

/** 全部阶段方案（来自后端 meta，两个部门的方案都在里面） */
const planOptionsAll = computed<StagePlanOption[]>(
  () => metaList.value.find((m) => m.planOptions?.length)?.planOptions || [],
);
/** 表单里可选的方案：按「部门」过滤 */
const formPlanOptions = computed(() => planOptionsAll.value.filter((p) => p.deptCode === form.deptCode));
/** 表单当前选中的方案 ID（只用于联动，不入库） */
const formPlanId = ref('');

/** 打开编辑弹窗时的原始状态 —— 状态下拉的可选项按它算，选完不会越点越多 */
const editStatusFrom = ref<number | null>(null);
const editStatusOptions = computed(() => classStatusOptions(editStatusFrom.value));

const formPhaseOptions = computed(() => {
  const plan = planOptionsAll.value.find((p) => p.id === formPlanId.value);
  if (plan) return plan.phases;
  const list = metaList.value.find((m) => m.stage === form.stage)?.phaseOptions || [];
  if (form.stage === 'jh') return list.filter((p) => JH_PHASE_CODES.includes(p.value));
  return list;
});

/** 阶段码 → 方案 ID（编辑回显时反查） */
function planIdOfPhase(phaseCode: number | null | undefined): string {
  if (!phaseCode) return '';
  return planOptionsAll.value.find((p) => p.phases.some((x) => x.value === Number(phaseCode)))?.id || '';
}

/* ============ 2026-10-15 改版：删除「学段」选择器，学段由部门判定 ============ */

/** 部门变化 → 自动判定学段（初高部 → 初高；大学部 → 大学）；实训学段不选部门时保持原值 */
function onFormDeptChange(v: number | undefined) {
  if (v === DeptCode.JUNIOR_SENIOR) form.stage = 'jh';
  else if (v === DeptCode.UNIVERSITY) form.stage = 'class';
  // 就业部同时覆盖「实训」和「就业」两个学段：已在 job/emp 时不要强行改学段
  else if (v === DeptCode.EMPLOYMENT && form.stage !== 'job' && form.stage !== 'emp') {
    form.stage = 'emp';
  }
  // ★ 2026-10-16 部门变了 → 原来选的「阶段方案」可能不属于新部门，先清掉
  if (!formPlanOptions.value.some((p) => p.id === formPlanId.value)) formPlanId.value = '';
  // 2026-10-19 批注：清掉之后默认选中新部门的方案（不允许空着）
  if (!formPlanId.value) formPlanId.value = formPlanOptions.value[0]?.id || '';
  // ★ 方案是按部门维护的：跨部门的选中值（方案 / 方案里的阶段 / 阶段名快照）一起清掉
  form.schemeId = null;
  form.schemeStageId = null;
  form.schemeStageName = null;
  // 学段变了：阶段按新学段重选（onFormStageChange 会清编号/交棒/备注等学段特有字段）
  if (!formPhaseOptions.value.some((p) => p.value === form.phaseCode)) form.phaseCode = undefined;
  onFormStageChange();
}

/* ============ 2026-10-15 改版：班主任/教员/助教接入「权限管理」用户列表 ============ */

const staffLoading = ref(false);
const staffOptions = ref<PermUserListItem[]>([]);

async function loadStaff() {
  staffLoading.value = true;
  try {
    // ⚠️ /api/perm/user/list 的 size 上限 100 —— 按 100/页自动翻页拉全量（≤5 页封顶）
    const out: PermUserListItem[] = [];
    const size = 100;
    const first = await userApi.list({ page: 1, size });
    out.push(...(first.list || []));
    const pages = Math.ceil((first.total || 0) / size);
    for (let p = 2; p <= Math.min(pages, 5); p++) {
      const d = await userApi.list({ page: p, size });
      out.push(...(d.list || []));
    }
    staffOptions.value = out;
  } catch {
    staffOptions.value = [];
  } finally {
    staffLoading.value = false;
  }
}

/** 编辑老班级时，原工号/ID 可能不在权限用户列表里 —— 兜底补一个选项，避免显示成裸 ID */
function withFallback(
  list: PermUserListItem[],
  id: string | null | undefined,
  name: string | null | undefined,
): PermUserListItem[] {
  if (!id || list.some((u) => u.id === id)) return list;
  return [{ id, userName: name || id } as PermUserListItem, ...list];
}

/** 岗位种类：前三个是建班岗位，后两个是交棒岗位（阶段=实训时必填） */
type StaffKind = 'headTeacher' | 'teacher' | 'assistant' | 'projectManager' | 'employmentTeacher';

/** 选人自动带姓名；清空时姓名一并清掉 */
function onStaffChange(kind: StaffKind, id: string) {
  const name = staffOptions.value.find((x) => x.id === id)?.userName || '';
  if (kind === 'headTeacher') form.headTeacherName = name;
  else if (kind === 'teacher') form.teacherName = name;
  else if (kind === 'assistant') form.assistantName = name;
  else if (kind === 'projectManager') form.projectManagerName = name;
  else form.employmentTeacherName = name;
}

/* ---------------- ★ 2026-10-16：阶段方案（方案 + 方案里的阶段） ---------------- */

/**
 * 方案选项（系统设置 · 阶段方案页维护）
 *
 * 【为什么按部门过滤】
 *   方案分部门（1 初高部 / 2 大学部）—— 与表单里的「部门」联动：
 *   选了初高部的班，只会列出初高部的方案。
 * 【数据从哪来】统一接口 /api/teaching/class/scheme-options（三个学段共用一份）。
 */
const schemeOptions = ref<SchemeOption[]>([]);

async function loadSchemeOptions() {
  try {
    schemeOptions.value = await getSchemeOptions();
  } catch {
    // 拿不到方案不影响建班（退回老的「阶段」阶段码选项）
    schemeOptions.value = [];
  }
}

/** 表单里按当前部门过滤后的方案 */
const formSchemeOptions = computed(() =>
  schemeOptions.value.filter((s) => !form.deptCode || s.deptCode === form.deptCode),
);

/** 当前选中方案里的阶段（=「阶段」下拉的选项来源） */
const formSchemeStageOptions = computed(() => {
  const scheme = schemeOptions.value.find((s) => s.id === form.schemeId);
  return scheme?.stages || [];
});

/** 切换方案：清掉上一个方案选中的阶段（阶段是方案内的，不跨方案复用） */
function onSchemeChange() {
  form.schemeStageId = null;
  form.schemeStageName = null;
}

/** 选中方案里的阶段：把阶段名冗余存一份（列表/详情直接回显） */
function onSchemeStageChange(id: string | null) {
  const hit = formSchemeStageOptions.value.find((s) => s.id === id);
  form.schemeStageName = hit ? hit.stageName : null;
}

/** 列表/详情里「阶段」列的回显：优先方案阶段名，老班级退回阶段码名称 */
function phaseTextOf(row: Pick<ClassRow, 'schemeStageName' | 'phaseName'>): string {
  return row.schemeStageName || row.phaseName || '—';
}

async function openCreate() {
  const stage = (query.stage || stageOptions.value[0]?.value || 'jh') as ClassStage;
  Object.assign(form, emptyForm(stage));
  // ★ 方案选项每次打开弹窗都刷新（刚在系统设置里建完方案，回来就能选到）
  await loadSchemeOptions();
  // 2026-10-19 批注：阶段方案要默认选中（该部门的那套方案），不用每次手点
  formPlanId.value = formPlanOptions.value[0]?.id || '';
  form.schemeId = formSchemeOptions.value[0]?.id || null;
  editStatusFrom.value = null;
  editVisible.value = true;
}

async function openEdit(row: ClassRow) {
  Object.assign(form, emptyForm(row.stage), {
    id: row.classId,
    className: row.className,
    classCode: row.classCode || '',
    deptCode: row.deptCode ?? undefined,
    phaseCode: row.phaseCode ?? undefined,
    classStatus: row.classStatus,
    schemeId: row.schemeId,
    schemeStageId: row.schemeStageId,
    schemeStageName: row.schemeStageName,
    headTeacherId: row.headTeacherId || '',
    headTeacherName: row.headTeacherName || '',
    teacherId: row.teacherId || '',
    teacherName: row.teacherName || '',
    assistantId: row.assistantId || '',
    assistantName: row.assistantName || '',
    projectManagerId: row.projectManagerId || '',
    projectManagerName: row.projectManagerName || '',
    employmentTeacherId: row.employmentTeacherId || '',
    employmentTeacherName: row.employmentTeacherName || '',
    universityNo: row.universityNo || '',
    classroom: row.classroom || '',
    openDate: row.openDate || '',
    closeDate: row.closeDate || '',
    remark: row.remark || '',
  });
  // ★ 2026-10-16 反查这个阶段属于哪个方案，让「阶段方案」下拉回显；
  //   2026-10-19 批注：查不到也要默认选中本部门的方案，不能空着
  formPlanId.value = planIdOfPhase(row.phaseCode) || formPlanOptions.value[0]?.id || '';
  // 「班级状态」可选项按**打开时的原始状态**算（否则选完一项选项会跟着变）
  editStatusFrom.value = row.classStatus;
  editVisible.value = true;
}

/** ★ 表单切学段：编号 / 交棒 / 备注字段要跟着清（否则会带着上一个学段的脏值提交） */
function onFormStageChange() {
  const keep = { id: form.id, className: form.className };
  Object.assign(form, emptyForm(form.stage), keep);
}

async function doSave() {
  // 教室在提交前再归一一次：只用键盘 Enter 提交时不一定触发过 blur
  form.classroom = normalizeClassroom(form.classroom);
  // 校验不通过就别往下走：原来直接 await validate() 会把 reject 抛成未捕获异常，
  // 界面上只有字段下面那行红字，看不到任何提示（加了「实训必填」规则后更容易踩到）
  if (formRef.value) {
    const ok = await formRef.value.validate().catch(() => false);
    if (!ok) return;
  }
  saving.value = true;
  try {
    await saveClass({ ...form });
    ElMessage.success(form.id ? '班级已更新' : '班级已创建');
    editVisible.value = false;
    load();
  } catch (e) {
    ElMessage.error((e as Error).message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function doDelete(row: ClassRow) {
  await ElMessageBox.confirm(
    `确定删除班级「${row.className}」吗？该班当前有 ${row.studentCount} 名学生，删除后不影响学生本人。`,
    '删除确认',
    { type: 'warning' },
  );
  await deleteClass(row.stage, row.classId);
  ElMessage.success('已删除');
  load();
}

/* ---------------- 班级交接（2026-10-19 批注） ---------------- */
type HandoverRoleKey = 'headTeacher' | 'teacher' | 'assistant' | 'projectManager' | 'employmentTeacher';

interface HandoverRoleItem {
  key: HandoverRoleKey;
  label: string;
  oldId: string;
  oldName: string;
  /** 留空 = 该岗位不换人 */
  newId: string;
  newName: string;
}

const handoverVisible = ref(false);
const handoverSaving = ref(false);
const handoverRoles = ref<HandoverRoleItem[]>([]);
const handoverForm = reactive({
  stage: 'jh' as ClassStage,
  classId: '',
  className: '',
  handoverDate: '',
  reason: '',
});

/** 今天的 YYYY-MM-DD（交接日期默认值） */
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function openHandover(row: ClassRow) {
  Object.assign(handoverForm, {
    stage: row.stage,
    classId: row.classId,
    className: row.className,
    handoverDate: todayStr(),
    reason: '',
  });
  const all: HandoverRoleItem[] = [
    { key: 'headTeacher', label: '班主任', oldId: row.headTeacherId || '', oldName: row.headTeacherName || '', newId: '', newName: '' },
    { key: 'teacher', label: '教员', oldId: row.teacherId || '', oldName: row.teacherName || '', newId: '', newName: '' },
    { key: 'assistant', label: '助教', oldId: row.assistantId || '', oldName: row.assistantName || '', newId: '', newName: '' },
    { key: 'projectManager', label: '项目经理', oldId: row.projectManagerId || '', oldName: row.projectManagerName || '', newId: '', newName: '' },
    { key: 'employmentTeacher', label: '就业老师', oldId: row.employmentTeacherId || '', oldName: row.employmentTeacherName || '', newId: '', newName: '' },
  ];
  // 初高没有后两个岗位（那两张表没这两列），不展示
  handoverRoles.value = row.stage === 'jh' ? all.slice(0, 3) : all;
  handoverVisible.value = true;
}

/** 选新人 → 自动带姓名（与编辑班级的选人规则一致） */
function onHandoverPick(row: HandoverRoleItem) {
  row.newName = staffOptions.value.find((u) => u.id === row.newId)?.userName || '';
}

async function doHandover() {
  const changed = handoverRoles.value.filter((r) => r.newId);
  if (!changed.length) {
    ElMessage.warning('请至少选择一个「新负责人」');
    return;
  }
  const payload: ClassHandoverPayload = {
    stage: handoverForm.stage,
    classId: handoverForm.classId,
    handoverDate: handoverForm.handoverDate || todayStr(),
    reason: handoverForm.reason || null,
  };
  for (const r of changed) {
    payload[`${r.key}Id`] = r.newId;
    payload[`${r.key}Name`] = r.newName;
  }
  handoverSaving.value = true;
  try {
    await doClassHandover(payload);
    ElMessage.success('交接已生效，已记入交接记录');
    handoverVisible.value = false;
    load();
  } catch (e) {
    ElMessage.error((e as Error).message || '交接失败');
  } finally {
    handoverSaving.value = false;
  }
}

/* ---------------- ★ 升实训（2026-10-20 批注：大学部 → 就业部） ----------------
 * 批注①（班级管理页红框 + 红字）：「【升实训】：部门选择为就业部，不再有班主任，教员，
 *   助教，选择项目经理，就业老师，班级名称可以进行修改，选择就业部的阶段方案」
 * 追问确认：整班全部转入；升实训=改变部门，班级名称可改也可保持原样。
 *
 * 只对**大学部（class）**班级显示入口 —— 初高部学生要先「升云」到大学部再走这一步。
 * 数据搬迁（建实训班 + 迁学生 + 写花名册 + 原班逻辑删除）全在后端一个事务里。
 */
const trainingVisible = ref(false);
const trainingSaving = ref(false);
const trainingForm = reactive({
  classId: '',
  srcName: '',
  studentCount: 0,
  className: '',
  phaseCode: undefined as number | undefined,
  projectManagerId: '',
  employmentTeacherId: '',
  remark: '',
});

/** 就业部阶段方案里的阶段（deptCode = 3，只取这一套，不要混进初高/大学的阶段码） */
const trainingPhaseOptions = computed(() => {
  const plans = metaList.value.flatMap((m) => m.planOptions || []);
  const seen = new Map<number, string>();
  for (const pl of plans) {
    if (pl.deptCode !== 3) continue;
    for (const p of pl.phases) if (!seen.has(p.value)) seen.set(p.value, p.label);
  }
  return [...seen].map(([value, label]) => ({ value, label }));
});

function openTraining(row: ClassRow) {
  Object.assign(trainingForm, {
    classId: row.classId,
    srcName: row.className,
    studentCount: row.studentCount ?? 0,
    // 批注：班级名称可以修改，也可以保持原班级名称不变
    className: row.className,
    phaseCode: trainingPhaseOptions.value[0]?.value,
    projectManagerId: '',
    employmentTeacherId: '',
    remark: '',
  });
  trainingVisible.value = true;
}

async function doTrainingUpgrade() {
  const name = trainingForm.className.trim() || trainingForm.srcName;
  if (!trainingForm.phaseCode) {
    ElMessage.warning('请选择就业部阶段');
    return;
  }
  if (!trainingForm.projectManagerId) {
    ElMessage.warning('请选择「项目经理」');
    return;
  }
  if (!trainingForm.employmentTeacherId) {
    ElMessage.warning('请选择「就业老师」');
    return;
  }
  if (!trainingForm.studentCount) {
    ElMessage.warning('该班级没有学生，无法升实训');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确认把「${trainingForm.srcName}」整班（${trainingForm.studentCount} 人）升实训为「${name}」？原班级将从大学部移除，学生状态变为「实训中」。`,
      '升实训确认',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  const pm = staffOptions.value.find((u) => u.id === trainingForm.projectManagerId);
  const et = staffOptions.value.find((u) => u.id === trainingForm.employmentTeacherId);
  trainingSaving.value = true;
  try {
    const r = await upgradeClassToTraining({
      classId: trainingForm.classId,
      className: name,
      phaseCode: trainingForm.phaseCode,
      projectManagerId: trainingForm.projectManagerId,
      projectManagerName: pm?.userName || '',
      employmentTeacherId: trainingForm.employmentTeacherId,
      employmentTeacherName: et?.userName || '',
      remark: trainingForm.remark || null,
    });
    ElMessage.success(`已升实训：${r.targetClassName}（${r.classCode}），转入 ${r.moved} 人`);
    trainingVisible.value = false;
    load();
  } catch (e) {
    ElMessage.error((e as Error).message || '升实训失败');
  } finally {
    trainingSaving.value = false;
  }
}

onMounted(() => {
  load(1);
  loadStaff();
  // 阶段方案选项（表单用）—— 先取一次，打开弹窗时还会再刷新
  loadSchemeOptions();
});
</script>

<style scoped>
.tcv {
  padding: 12px;
}
/* 「阶段」下拉里右侧的学制标注 */
.stage-months {
  float: right;
  margin-left: 12px;
  color: #909399;
  font-size: 12px;
}
.tcv-tip {
  margin-bottom: 10px;
}
.muted {
  color: #A2938E;
  font-weight: normal;
}
.tcv-cards {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.tcv-card {
  background: #fff;
  border: 1px solid #F1EAE5;
  border-radius: 6px;
  padding: 10px 14px;
  min-width: 190px;
}
.tcv-card__k {
  font-size: 12px;
  color: #A2938E;
}
.tcv-card__v {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.4;
}
.tcv-card__x {
  font-size: 12px;
  color: #7A6C67;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.tcv-filter {
  background: #fff;
  padding: 10px 10px 0;
  border-radius: 6px;
}
.tcv-page {
  margin-top: 12px;
  justify-content: flex-end;
}

/* ---- 交接记录（详情抽屉）---- */
.ho-line {
  line-height: 1.6;
  font-size: 12px;
}
.ho-role {
  display: inline-block;
  width: 52px;
  color: #909399;
}
.ho-old {
  color: #606266;
}
.ho-arrow {
  margin: 0 4px;
  color: #c0c4cc;
}
.ho-new {
  color: #409eff;
  font-weight: 600;
}
.ho-empty {
  color: #c0c4cc;
}
.ho-reason {
  margin-top: 12px;
}
.link {
  color: #CD3A33;
  cursor: pointer;
}
.ok {
  color: #5FA36F;
}
.warn {
  color: #C9852E;
}
.danger {
  color: #CD3A33;
}
</style>