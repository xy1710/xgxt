<template>
  <div class="page-container">
    <!-- ============ 主 Tab ============ -->
    <el-tabs v-model="mainTab" class="main-tabs" @tab-change="handleTabChange">
      <el-tab-pane label="缴费总记录" name="total" />
      <el-tab-pane label="即将到期" name="expiring" />
    </el-tabs>

    <!-- ============================================================
         Tab 1：缴费总记录
         列：类别 / 班级 / 班主任 / 学生姓名 / 缴费时间 / 到期时间 / 状态 / 操作
         ============================================================ -->
    <template v-if="mainTab === 'total'">
      <!-- ============ 缴费类别子页签 ============ -->
      <el-tabs v-model="feeTab" class="sub-tabs" @tab-change="onFeeTabChange">
        <el-tab-pane v-for="c in FEE_TYPES" :key="c" :name="c">
          <template #label>
            <span>{{ c }}</span>
            <span class="tab-count">{{ totalStats.byCategory[c] ?? 0 }}</span>
          </template>
        </el-tab-pane>
      </el-tabs>

      <!-- 统计卡片（点一下就切换下面的状态筛选） -->
      <div class="stat-row">
        <el-card
          v-for="s in totalStatsCards"
          :key="s.key"
          shadow="never"
          class="stat-card clickable"
          :class="{ 'is-active': statsActiveKey === s.key }"
          @click="onStatsCardClick(s.key)"
        >
          <div class="stat-icon" :style="{ background: s.bg, color: s.color }">{{ s.icon }}</div>
          <div class="stat-info">
            <span class="stat-num">{{ s.value }}</span>
            <span class="stat-label">{{ s.label }}</span>
          </div>
        </el-card>
      </div>

      <!-- 筛选 -->
      <el-card shadow="never" class="search-card">
      <!-- ★ 2026-10-19：筛选「选完即查」（@change → loadTotal），不用再点筛选 -->
        <el-form :model="totalQuery" inline>
          <el-form-item label="班级">
            <el-select
              v-model="totalQuery.className"
              placeholder="全部"
              clearable
              filterable
              style="width: 140px"
              @change="loadTotal"
            >
              <el-option v-for="c in ALL_CLASSES" :key="c" :label="c" :value="c" />
            </el-select>
          </el-form-item>
          <el-form-item label="关键字">
            <el-input
              v-model="totalQuery.keyword"
              placeholder="类别 / 班级 / 班主任 / 姓名 / 日期"
              clearable
              style="width: 240px"
              @keyup.enter="loadTotal"
              @clear="loadTotal"
            />
          </el-form-item>
          <el-form-item label="状态">
            <el-select
              v-model="totalQuery.frozenFilter"
              placeholder="全部"
              style="width: 120px"
              @change="loadTotal"
            >
              <el-option v-for="s in PAY_STATUS_FILTERS" :key="s.value" :label="s.label" :value="s.value" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :icon="Search" @click="loadTotal">筛选</el-button>
            <el-button :icon="Refresh" @click="resetTotal">重置</el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <!-- 表格 -->
      <el-card shadow="never" class="table-card">
        <div class="toolbar">
          <el-button v-if="canAct('edu:fee:add', true)" type="primary" :icon="Plus" @click="openAdd">+ 新建学生信息</el-button>
          <el-button v-if="canAct('edu:fee:import', true)" :icon="Upload" @click="importVisible = true">导入</el-button>
          <span class="toolbar-gap" />
          <span class="toolbar-hint">已选 {{ selectedPaymentIds.length }} 条</span>
          <el-button
            v-if="canAct('edu:fee:freeze', true)"
            type="danger"
            :icon="Lock"
            :disabled="selectedPaymentIds.length === 0"
            @click="handleBatchFreeze(true)"
          >
            批量冻结
          </el-button>
          <el-button
            v-if="canAct('edu:fee:freeze', true)"
            type="success"
            :icon="Unlock"
            :disabled="selectedPaymentIds.length === 0"
            @click="handleBatchFreeze(false)"
          >
            批量解冻
          </el-button>
        </div>

        <el-table
          ref="totalTableRef"
          v-loading="totalLoading"
          :data="totalList"
          border
          stripe
          row-key="paymentId"
          @selection-change="onPaymentSelectionChange"
        >
          <el-table-column type="selection" width="46" align="center" reserve-selection />
          <el-table-column prop="studentNo" label="学号" width="120" align="center">
            <template #default="{ row }">
              <span :class="row.studentNo ? '' : 'empty-text'">{{ row.studentNo || '-' }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="studentName" label="姓名" width="110" align="center" />
          <el-table-column prop="className" label="班级" width="110" align="center">
            <template #default="{ row }">
              <span :class="row.className ? '' : 'empty-text'">{{ row.className || '-' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="学生状态" width="110" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.studentStatusName" :type="getStatusTagType(row.studentStatusName)" size="small">
                {{ row.studentStatusName }}
              </el-tag>
              <span v-else class="empty-text">-</span>
            </template>
          </el-table-column>
          <el-table-column label="缴费类型" width="110" align="center">
            <template #default="{ row }">
              <el-tag :type="getFeeTagType(row.category)" size="small">{{ row.category }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column
            prop="payDate"
            label="缴费日期"
            width="120"
            align="center"
            :formatter="dateCell"
          />
          <el-table-column
            prop="expiryDate"
            label="到期日期"
            width="120"
            align="center"
            :formatter="dateCell"
          />
          <el-table-column label="状态" width="130" align="center">
            <template #default="{ row }">
              <el-tag :type="row.frozen ? 'info' : 'success'" size="small">
                {{ row.payStatusName }}
              </el-tag>
              <!-- 系统冻结：多给一个标记，说明这不是教务手动点的 -->
              <el-tooltip v-if="row.autoFrozen" :content="AUTO_FROZEN_TIP" placement="top">
                <span class="auto-tag">系统</span>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110" align="center" fixed="right">
            <template #default="{ row }">
              <!-- 学生休学/退学 → 不允许人工解冻，必须先在学生档案改状态 -->
              <el-tooltip
                v-if="row.autoFrozen"
                :content="AUTO_FROZEN_TIP"
                placement="top"
                :disabled="false"
              >
                <span class="btn-disabled">解冻</span>
              </el-tooltip>
              <el-button
                v-else-if="canAct('edu:fee:freeze', true)"
                link
                :type="row.frozen ? 'primary' : 'danger'"
                @click="handleToggleFreeze(row)"
              >
                {{ row.frozen ? '解冻' : '冻结' }}
              </el-button>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty :description="`${feeTab}暂无缴费记录，可点上方「新建学生信息」添加`" />
          </template>
        </el-table>

        <div class="pager">
          <el-pagination
            v-model:current-page="totalQuery.page"
            v-model:page-size="totalQuery.size"
            :total="totalTotal"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next, jumper"
            @size-change="loadTotal"
            @current-change="loadTotal"
          />
        </div>
      </el-card>
    </template>

    <!-- ============================================================
         Tab 2：即将到期
         按缴费类别分成 学费 / 住宿费 / 保险费 / 餐费 四个子页
         列：学号 / 姓名 / 班级 / 缴费类型 / 缴费金额 / 订单号 / 缴费状态 /
             缴费日期 / 到期日期 / 凭证 / 班主任 / 操作
         缴费金额和订单号来自「上传凭证」弹窗里的截图识别结果，确认上传后才显示
         ============================================================ -->
    <template v-else>
      <!-- ============ 缴费类别子页签 ============ -->
      <el-tabs v-model="expFeeTab" class="sub-tabs" @tab-change="onExpFeeTabChange">
        <el-tab-pane v-for="c in FEE_TYPES" :key="c" :name="c">
          <template #label>
            <span>{{ c }}</span>
            <span class="tab-count">{{ expStats.byCategory[c] ?? 0 }}</span>
          </template>
        </el-tab-pane>
      </el-tabs>

      <!-- 统计卡片 -->
      <div class="stat-row">
        <el-card v-for="s in expStatsCards" :key="s.label" shadow="never" class="stat-card">
          <div class="stat-icon" :style="{ background: s.bg, color: s.color }">{{ s.icon }}</div>
          <div class="stat-info">
            <span class="stat-num">{{ s.value }}</span>
            <span class="stat-label">{{ s.label }}</span>
          </div>
        </el-card>
      </div>

      <!-- 筛选 -->
      <el-card shadow="never" class="search-card">
      <!-- ★ 2026-10-19：筛选「选完即查」（@change → reloadExpiringWithClear，筛选变了勾选结果一并清空） -->
        <el-form :model="expQuery" inline>
          <el-form-item label="班级">
            <el-select
              v-model="expQuery.className"
              placeholder="全部"
              clearable
              filterable
              style="width: 140px"
              @change="reloadExpiringWithClear"
            >
              <el-option v-for="c in ALL_CLASSES" :key="c" :label="c" :value="c" />
            </el-select>
          </el-form-item>
          <el-form-item label="缴费状态">
            <el-select
              v-model="expQuery.payStatus"
              placeholder="全部"
              clearable
              style="width: 110px"
              @change="reloadExpiringWithClear"
            >
              <el-option v-for="s in PAY_PAID_STATUS_LIST" :key="s" :label="s" :value="s" />
            </el-select>
          </el-form-item>
          <el-form-item label="凭证">
            <el-select
              v-model="expQuery.certStatus"
              placeholder="全部"
              clearable
              style="width: 110px"
              @change="reloadExpiringWithClear"
            >
              <el-option v-for="s in CERT_STATUS_LIST" :key="s" :label="s" :value="s" />
            </el-select>
          </el-form-item>
          <el-form-item label="关键字">
            <el-input
              v-model="expQuery.keyword"
              placeholder="学号 / 姓名 / 班级 / 班主任 / 日期"
              clearable
              style="width: 240px"
              @keyup.enter="loadExpiring"
              @clear="reloadExpiringWithClear"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :icon="Search" @click="reloadExpiringWithClear">筛选</el-button>
            <el-button :icon="Refresh" @click="resetExpiring">重置</el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <!-- 表格 -->
      <el-card shadow="never" class="table-card">
        <div class="toolbar">
          <span class="toolbar-hint end-hint">
            已选 <b :class="selectedExpIds.length ? 'sel-on' : ''">{{ selectedExpIds.length }}</b>
            条<template v-if="selectedExpIds.length">
              （可上传 {{ selectedUploadableIds.length }} 条）</template
            >
            <el-link v-if="selectedExpIds.length" type="primary" @click="clearExpSelection">
              清空
            </el-link>
          </span>
          <el-button
            v-if="canAct('edu:fee:import', true)"
            type="warning"
            :icon="Upload"
            :disabled="selectedUploadableIds.length === 0"
            @click="handleBatchUpload"
          >
            批量上传
          </el-button>
          <el-button v-if="canAct('edu:fee:notify', true)" type="primary" :icon="Bell" @click="handleNotifyAll">一键通知</el-button>
        </div>

        <el-table
          ref="expTableRef"
          v-loading="expLoading"
          :data="expList"
          border
          stripe
          row-key="paymentId"
          @selection-change="onExpSelectionChange"
        >
          <el-table-column
            type="selection"
            width="46"
            align="center"
            reserve-selection
            :selectable="canSelectExpRow"
          />
          <el-table-column prop="studentNo" label="学号" width="120" align="center">
            <template #default="{ row }">
              <span :class="row.studentNo ? '' : 'empty-text'">{{ row.studentNo || '-' }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="studentName" label="姓名" width="100" align="center" />
          <el-table-column prop="className" label="班级" width="100" align="center">
            <template #default="{ row }">
              <span :class="row.className ? '' : 'empty-text'">{{ row.className || '-' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="缴费类型" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="getFeeTagType(row.category)" size="small">{{ row.category }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="缴费金额" width="110" align="right">
            <template #default="{ row }">
              <span>{{ formatAmount(row.amount) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="订单号" width="180" align="center">
            <template #default="{ row }">
              <span :class="row.orderNo ? '' : 'empty-text'">{{ row.orderNo || '-' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="缴费状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="getPayPaidTagType(row.payStatus)" size="small">
                {{ row.payStatusName }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            prop="payDate"
            label="缴费日期"
            width="120"
            align="center"
            :formatter="dateCell"
          />
          <el-table-column label="到期日期" width="160" align="center">
            <template #default="{ row }">
              <span>{{ formatDateOnly(row.expiryDate) }}</span>
              <span :class="row.urgent ? 'urgent-text' : 'warn-text'" class="days-left">
                {{ row.remark }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="凭证" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="getCertTagType(row.certStatus)" size="small">
                {{ row.certStatusName }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="headTeacherName" label="班主任" width="100" align="center" />
          <el-table-column label="操作" width="170" align="center" fixed="right">
            <template #default="{ row }">
              <!-- 已缴 且 未传 → 上传 -->
              <el-button
                v-if="row.canUpload"
                link
                type="primary"
                @click="openUpload(row)"
              >
                上传
              </el-button>
              <!-- 凭证被打回 → 重新上传 + 通知 -->
              <template v-else-if="row.canReupload || row.canNotify">
                <el-button link type="warning" @click="openUpload(row)">重新上传</el-button>
                <el-button link type="primary" @click="handleNotifyOne(row)">通知</el-button>
              </template>
              <!-- 其余（未缴 / 已传）置灰，hover 说明原因 -->
              <el-tooltip v-else :content="row.actionTip" placement="top">
                <span class="btn-disabled">上传</span>
              </el-tooltip>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty :description="`${expFeeTab}暂无临期记录`" />
          </template>
        </el-table>

        <div class="pager">
          <el-pagination
            v-model:current-page="expQuery.page"
            v-model:page-size="expQuery.size"
            :total="expTotal"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next, jumper"
            @size-change="loadExpiring"
            @current-change="loadExpiring"
          />
        </div>
      </el-card>
    </template>

    <!-- ============ 新建弹窗 ============ -->
    <el-dialog v-model="addVisible" title="新建学生缴费信息" width="520px">
      <el-form ref="addFormRef" :model="addForm" :rules="addRules" label-width="90px">
        <el-form-item label="类别" prop="category">
          <el-select v-model="addForm.category" style="width: 100%" @change="onAddCategoryChange">
            <el-option v-for="c in FEE_TYPES" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="班级" prop="className">
          <el-select
            v-model="addForm.className"
            placeholder="请选择班级"
            filterable
            style="width: 100%"
            @change="onAddClassChange"
          >
            <el-option v-for="c in ALL_CLASSES" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="班主任" prop="headTeacherName">
          <el-input v-model="addForm.headTeacherName" placeholder="留空则按班级自动带出" />
        </el-form-item>
        <el-form-item label="学号">
          <el-input v-model="addForm.studentNo" placeholder="选填，填了会带出学生状态" />
        </el-form-item>
        <el-form-item label="学生姓名" prop="studentName">
          <el-input v-model="addForm.studentName" placeholder="请输入学生姓名" />
        </el-form-item>
        <el-form-item label="缴费金额（元）">
          <el-input-number
            v-model="addForm.amount"
            :min="0"
            :step="100"
            controls-position="right"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="缴费状态">
          <el-select v-model="addForm.payStatus" style="width: 100%">
            <el-option v-for="s in PAY_PAID_STATUS_LIST" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="缴费时间" prop="payDate">
          <el-date-picker
            v-model="addForm.payDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择日期"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="到期时间" prop="expiryDate">
          <el-date-picker
            v-model="addForm.expiryDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择日期"
            style="width: 100%"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAdd">创建</el-button>
      </template>
    </el-dialog>

    <!-- ============ 上传凭证弹窗（凭证被打回时是「重新上传」）============
         流程：选择缴费截图 → 自动识别金额和订单号（只读回填）→ 确认上传后才落库
         ============================================================ -->
    <el-dialog
      v-model="uploadVisible"
      :title="isReupload ? '重新上传缴费凭证' : '上传缴费凭证'"
      width="560px"
      @closed="resetUploadDialog"
    >
      <div v-if="uploadTarget" class="upload-info">
        <strong>{{ uploadTarget.studentName }}</strong>
        <span v-if="uploadTarget.studentNo">（{{ uploadTarget.studentNo }}）</span>
        · {{ uploadTarget.className }} ·
        <el-tag :type="getFeeTagType(uploadTarget.category)" size="small">
          {{ uploadTarget.category }}
        </el-tag>
        · 到期：{{ uploadTarget.expiryDate }}
      </div>
      <el-alert
        v-if="isReupload"
        type="warning"
        :closable="false"
        show-icon
        title="原凭证被打回，请重新上传有效凭证"
        style="margin-top: 12px"
      />
      <el-form label-width="88px" style="margin-top: 14px">
        <el-form-item label="缴费截图">
          <el-upload
            ref="shotUploadRef"
            :auto-upload="false"
            :limit="1"
            :accept="OCR_ACCEPT"
            list-type="picture-card"
            :on-change="onShotChange"
            :on-remove="onShotRemove"
          >
            <el-icon><Plus /></el-icon>
          </el-upload>
          <div class="ocr-tip">
            支持 jpg / png / bmp / webp，单张不超过 {{ OCR_MAX_SIZE_MB }}MB
          </div>
        </el-form-item>

        <el-form-item label="缴费金额">
          <el-input :model-value="ocrAmountText" readonly disabled class="ocr-field">
            <template v-if="ocrLoading" #prefix>
              <el-icon class="is-loading"><Loading /></el-icon>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item label="订单号">
          <el-input :model-value="ocrOrderText" readonly disabled class="ocr-field">
            <template v-if="ocrLoading" #prefix>
              <el-icon class="is-loading"><Loading /></el-icon>
            </template>
          </el-input>
        </el-form-item>

        <el-alert
          v-if="ocrState === 'recognizing'"
          type="info"
          :closable="false"
          show-icon
          title="正在识别截图中的金额和订单号…"
        />
        <el-alert
          v-else-if="ocrState === 'fail'"
          type="error"
          :closable="false"
          show-icon
          :title="ocrErrorText"
        />
        <el-alert
          v-else-if="ocrState === 'partial'"
          type="warning"
          :closable="false"
          show-icon
          title="截图只识别出了部分信息，未识别到的一栏将留空"
        />
        <el-alert
          v-else-if="ocrState === 'done'"
          type="success"
          :closable="false"
          show-icon
          title="识别成功"
          :description="OCR_READONLY_TIP"
        />
        <div v-else class="ocr-tip muted">先选择缴费截图，系统会自动识别金额和订单号</div>

        <el-form-item label="备注" style="margin-top: 12px">
          <el-input v-model="uploadRemark" type="textarea" :rows="2" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="uploadVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="uploading"
          :disabled="!canSubmitUpload"
          @click="submitUpload"
        >
          确认上传
        </el-button>
      </template>
    </el-dialog>

    <!-- ============ 批量上传弹窗 ============ -->
    <el-dialog v-model="batchVisible" title="批量上传凭证" width="560px">
      <p class="batch-tip">
        已勾选 <strong>{{ batchCount }}</strong> 条，确认后标记为「已上传」
      </p>
      <el-table :data="batchTargets" size="small" border max-height="220">
        <el-table-column prop="studentNo" label="学号" width="110" align="center">
          <template #default="{ row }">
            <span :class="row.studentNo ? '' : 'empty-text'">{{ row.studentNo || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="studentName" label="姓名" width="90" align="center" />
        <el-table-column prop="className" label="班级" width="100" align="center" />
        <el-table-column label="缴费类型" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="getFeeTagType(row.category)" size="small">{{ row.category }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="金额" width="100" align="right">
          <template #default="{ row }">{{ formatAmount(row.amount) }}</template>
        </el-table-column>
        <el-table-column label="凭证" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="getCertTagType(row.certStatus)" size="small">
              {{ row.certStatusName }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <p class="batch-tip muted">未缴、凭证已传的记录无法勾选，也不会被处理</p>
      <el-upload
        :auto-upload="false"
        multiple
        :file-list="batchFileList"
        :on-change="onBatchFileChange"
        :on-remove="onBatchFileRemove"
      >
        <el-button :icon="UploadFilled">选择凭证文件</el-button>
        <template #tip>
          <div class="el-upload__tip">支持一次选择多个文件</div>
        </template>
      </el-upload>
      <template #footer>
        <el-button @click="batchVisible = false">取消</el-button>
        <el-button type="primary" @click="submitBatch">确认批量上传</el-button>
      </template>
    </el-dialog>

    <!-- ============ 导入弹窗 ============ -->
    <el-dialog v-model="importVisible" title="导入缴费记录" width="520px">
      <div class="import-tip">
        <el-button link type="primary" :icon="Download" @click="downloadTemplate">
          下载导入模板
        </el-button>
        <span>
          请按模板格式填写：学号 / 类别 / 班级 / 班主任 / 学生姓名 / 缴费金额 / 缴费状态 /
          缴费时间 / 到期时间
        </span>
      </div>
      <el-upload drag :auto-upload="false" :limit="1" accept=".xlsx,.xls,.csv" :on-change="onImportFileChange">
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">将文件拖到此处，或<em>点击上传</em></div>
        <template #tip>
          <div class="el-upload__tip">支持 xlsx / xls / csv 文件</div>
        </template>
      </el-upload>
      <div v-if="importResult" class="import-result">
        <el-alert
          :type="importResult.failed > 0 ? 'warning' : 'success'"
          :closable="false"
          show-icon
          :title="`导入完成：成功 ${importResult.success} 条，失败 ${importResult.failed} 条`"
        />
        <ul v-if="importResult.failures.length" class="fail-list">
          <li v-for="(f, i) in importResult.failures" :key="i">第 {{ f.row }} 行：{{ f.reason }}</li>
        </ul>
      </div>
      <template #footer>
        <el-button @click="importVisible = false">取消</el-button>
        <el-button type="primary" :loading="importing" @click="submitImport">确认导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 缴费管理
 *
 * 来源：教务管理原型 payment.html
 * 视觉沿用已联库页面的 Element Plus 风格（蓝 header / 白卡片 / 斑马纹表格 / el-tag 徽章）
 *
 * 两个 Tab：
 *   1. 缴费总记录 —— 类别+班级+关键字筛选，冻结 ⇄ 启动，新建
 *   2. 即将到期   —— 剩余 0~30 天且未冻结的记录，状态流转 待通知 → 待上传 → 已上传
 */
import { ref, reactive, computed, onMounted } from 'vue';
import { canAct } from '@/store/permission';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules, type TableInstance } from 'element-plus';
import {
  Search,
  Refresh,
  Plus,
  Upload,
  UploadFilled,
  Download,
  Bell,
  Lock,
  Unlock,
  Loading,
} from '@element-plus/icons-vue';
import {
  FEE_TYPES,
  FEE_TAG_TYPE,
  ALL_CLASSES,
  HEAD_TEACHERS,
  PAYMENT_PAGE_SIZE,
  PAY_STATUS_FILTERS,
  FEE_BASE_AMOUNT,
  PAY_PAID_STATUS_LIST,
  PAY_PAID_TAG_TYPE,
  CERT_STATUS_LIST,
  CERT_STATUS_TAG_TYPE,
  CertStatus,
  NOTIFY_NEED_REJECT_TIP,
  AUTO_FROZEN_TIP,
  OCR_ACCEPT,
  OCR_MAX_SIZE_MB,
  OCR_NEED_IMAGE_TIP,
  OCR_FAILED_TIP,
  OCR_READONLY_TIP,
  type OcrResult,
  type PaymentItem,
  type ExpiringItem,
  type PaymentTotalStats,
  type PaymentExpiringStats,
} from 'shared-types/edu';
import {
  fetchPaymentStats,
  fetchExpiringStats,
  fetchPaymentList,
  fetchExpiringList,
  togglePaymentFreeze,
  batchFreeze,
  addPayment,
  notifyOne,
  notifyAll,
  uploadCertificate,
  recognizeCertificate,
  batchUpload,
  importPayments,
} from '@/api/edu/payment';

const mainTab = ref<'total' | 'expiring'>('total');

// ==================== Tab 1：缴费总记录 ====================

const totalLoading = ref(false);
const totalList = ref<PaymentItem[]>([]);
const totalTotal = ref(0);
const totalTableRef = ref<TableInstance>();

/**
 * 表格里勾选的行（批量冻结/解冻用），跨分页保留
 * ⚠️ 存整行而不是只存 id：要知道哪些是「系统冻结」才能在确认框里提前提示
 */
const selectedPayments = ref<PaymentItem[]>([]);
const selectedPaymentIds = computed(() => selectedPayments.value.map((r) => r.paymentId));

/** 缴费总记录下的类别子页签：学费 / 住宿费 / 保险费 / 餐费 */
const feeTab = ref<string>(FEE_TYPES[0] as string);

const totalQuery = reactive({
  page: 1,
  size: PAYMENT_PAGE_SIZE,
  className: '',
  keyword: '',
  frozenFilter: 'all' as 'all' | 'normal' | 'frozen',
});

const totalStats = reactive<PaymentTotalStats>({
  total: 0,
  normal: 0,
  frozen: 0,
  expiring: 0,
  byCategory: {},
});

/** 状态筛选键：all=全部 / normal=正常 / frozen=已冻结 */
type PayFilterKey = 'all' | 'normal' | 'frozen' | 'expiring';

interface StatsCard {
  key: PayFilterKey;
  label: string;
  value: number;
  icon: string;
  bg: string;
  color: string;
}

const totalStatsCards = computed<StatsCard[]>(() => [
  { key: 'all', label: '缴费总记录', value: totalStats.total, icon: '💰', bg: '#FDF4F2', color: '#CD3A33' },
  { key: 'normal', label: '正常', value: totalStats.normal, icon: '✓', bg: '#EBF5EF', color: '#5FA36F' },
  { key: 'frozen', label: '已冻结', value: totalStats.frozen, icon: '❄', bg: '#F1EBE7', color: '#A2938E' },
  { key: 'expiring', label: '临期记录', value: totalStats.expiring, icon: '⏰', bg: '#FBF3E5', color: '#C9852E' },
]);

/** 当前高亮哪张卡：和状态筛选保持同步 */
const statsActiveKey = computed<PayFilterKey>(() => totalQuery.frozenFilter);

function buildTotalParams() {
  return {
    page: totalQuery.page,
    size: totalQuery.size,
    category: feeTab.value,
    className: totalQuery.className || undefined,
    keyword: totalQuery.keyword || undefined,
    frozenFilter: totalQuery.frozenFilter,
  };
}

async function loadTotal() {
  totalLoading.value = true;
  try {
    const res = await fetchPaymentList(buildTotalParams());
    totalList.value = res.list;
    totalTotal.value = res.total;
    await loadTotalStats();
  } finally {
    totalLoading.value = false;
  }
}

async function loadTotalStats() {
  const s = await fetchPaymentStats();
  Object.assign(totalStats, s);
}

function resetTotal() {
  totalQuery.className = '';
  totalQuery.keyword = '';
  totalQuery.frozenFilter = 'all';
  totalQuery.page = 1;
  clearPaymentSelection();
  loadTotal();
}

/** 切类别子页签：回到第一页重新拉，并清掉上一页的勾选（不同类别不该串着选） */
function onFeeTabChange() {
  totalQuery.page = 1;
  clearPaymentSelection();
  loadTotal();
}

function clearPaymentSelection() {
  selectedPayments.value = [];
  totalTableRef.value?.clearSelection();
}

function onPaymentSelectionChange(rows: PaymentItem[]) {
  selectedPayments.value = rows;
}

/** 批量冻结 / 批量解冻：作用于当前勾选的行 */
async function handleBatchFreeze(frozen: boolean) {
  const n = selectedPaymentIds.value.length;
  if (n === 0) {
    ElMessage.warning('请先勾选要操作的记录');
    return;
  }
  try {
    await ElMessageBox.confirm(
      buildBatchConfirmText(frozen),
      frozen ? '批量冻结' : '批量解冻',
      { type: 'warning', dangerouslyUseHTMLString: true },
    );
  } catch {
    return;
  }

  try {
    const res = await batchFreeze({ ids: selectedPaymentIds.value, frozen });
    ElMessage.success(
      res.skipped > 0
        ? `已${frozen ? '冻结' : '解冻'} ${res.count} 条，${res.skipped} 条因学生休学/退学未解冻`
        : `已${frozen ? '冻结' : '解冻'} ${res.count} 条`,
    );
  } catch {
    // 后端会明确提示「都已经是冻结状态」这类原因，错误已由拦截器统一弹出
    return;
  }
  clearPaymentSelection();
  loadTotal();
}

/** 勾选里混有系统冻结记录时，确认框里提前说清楚会跳过几条 */
function buildBatchConfirmText(frozen: boolean): string {
  const n = selectedPaymentIds.value.length;
  if (frozen) return `确认冻结已勾选的 ${n} 条${feeTab.value}记录？`;

  const locked = selectedPayments.value.filter((r) => r.autoFrozen).length;

  return locked > 0
    ? `确认解冻已勾选的 ${n} 条${feeTab.value}记录？<br/>
       <span style="color:#C9852E">其中 ${locked} 条属于学生休学/退学的系统冻结，不会被解冻</span>`
    : `确认解冻已勾选的 ${n} 条${feeTab.value}记录？`;
}

/**
 * 统计卡可以按冻结状态反查，点一下就联动上面的状态筛选
 * （和「学费/住宿费…」的子页签不同，这里要保持在当前类别页，不跳类别）
 */
function onStatsCardClick(key: PayFilterKey) {
  if (key === 'expiring') {
    mainTab.value = 'expiring';
    return;
  }
  totalQuery.frozenFilter = key;
  totalQuery.page = 1;
  clearPaymentSelection();
  loadTotal();
}

/** 类别徽章配色：学费=红 住宿费=蓝 保险费=橙 餐费=绿，沿用 Element Plus 的 type */
function getFeeTagType(category: string) {
  return FEE_TAG_TYPE[category] || 'info';
}

/** 学生状态徽章配色：在读=绿 试学中=蓝 休学=橙 退学=灰 */
function getStatusTagType(status: string) {
  if (status === '正式在读') return 'success';
  if (status === '试学中') return 'primary';
  if (status === '休学') return 'warning';
  if (status === '退学') return 'info';
  return 'info';
}

async function handleToggleFreeze(row: PaymentItem) {
  const toFrozen = !row.frozen;
  try {
    await ElMessageBox.confirm(
      `确认${toFrozen ? '冻结' : '启动'}「${row.studentName}」的这条缴费记录？`,
      '提示',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  await togglePaymentFreeze(row.paymentId);
  ElMessage.success(toFrozen ? '已冻结' : '已解冻');
  loadTotal();
}

// ==================== Tab 2：即将到期 ====================

const expLoading = ref(false);
const expList = ref<ExpiringItem[]>([]);
const expTotal = ref(0);
const expTableRef = ref<any>(null);

/** 表格里勾选的行：批量上传只处理这些（跨分页保留，换子页/筛选后清空） */
const selectedExpIds = ref<string[]>([]);

/** 即将到期下的类别子页签：学费 / 住宿费 / 保险费 / 餐费 */
const expFeeTab = ref<string>(FEE_TYPES[0] as string);

const expQuery = reactive({
  page: 1,
  size: PAYMENT_PAGE_SIZE,
  className: '',
  payStatus: '',
  certStatus: '',
  keyword: '',
});

const expStats = reactive<PaymentExpiringStats>({
  total: 0,
  paid: 0,
  unpaid: 0,
  certUploaded: 0,
  certRejected: 0,
  byCategory: {},
});

const expStatsCards = computed(() => [
  { label: '临期总记录', value: expStats.total, icon: '📋', bg: '#FDF4F2', color: '#CD3A33' },
  { label: '已缴', value: expStats.paid, icon: '✓', bg: '#EBF5EF', color: '#5FA36F' },
  { label: '未缴', value: expStats.unpaid, icon: '⏳', bg: '#F1EBE7', color: '#A2938E' },
  { label: '凭证已传', value: expStats.certUploaded, icon: '📎', bg: '#FDF4F2', color: '#CD3A33' },
  { label: '凭证被打回', value: expStats.certRejected, icon: '⚠', bg: '#F9E4E1', color: '#CD3A33' },
]);

/**
 * 当前类别下还能上传凭证的条数 = 已缴 - 凭证已传
 * （未缴的不允许上传，凭证已传的不用重复传）
 */
const uploadableCount = computed(() =>
  Math.max(0, expStats.paid - expStats.certUploaded),
);

/** 勾选的行里真正能上传的（未缴、凭证已传的会被排除） */
const selectedUploadableIds = computed(() =>
  selectedExpIds.value.filter((id) => {
    const row = expList.value.find((r) => r.paymentId === id);
    return row?.canUpload || row?.canReupload;
  }),
);

/** 复选框只有「可上传」的行能勾：未缴、凭证已传的直接禁掉，避免勾了也白勾 */
function canSelectExpRow(row: ExpiringItem) {
  return Boolean(row.canUpload || row.canReupload);
}

function onExpSelectionChange(rows: ExpiringItem[]) {
  selectedExpIds.value = rows.map((r) => r.paymentId);
}

function clearExpSelection() {
  selectedExpIds.value = [];
  expTableRef.value?.clearSelection();
}

function buildExpParams() {
  return {
    page: expQuery.page,
    size: expQuery.size,
    category: expFeeTab.value,
    className: expQuery.className || undefined,
    payStatus: expQuery.payStatus || undefined,
    certStatus: expQuery.certStatus || undefined,
    keyword: expQuery.keyword || undefined,
  };
}

async function loadExpiring() {
  expLoading.value = true;
  try {
    const res = await fetchExpiringList(buildExpParams());
    expList.value = res.list;
    expTotal.value = res.total;
    await loadExpiringStats();
  } finally {
    expLoading.value = false;
  }
}

async function loadExpiringStats() {
  const s = await fetchExpiringStats(expFeeTab.value);
  Object.assign(expStats, s);
}

function resetExpiring() {
  expQuery.className = '';
  expQuery.payStatus = '';
  expQuery.certStatus = '';
  expQuery.keyword = '';
  expQuery.page = 1;
  clearExpSelection();
  loadExpiring();
}

/** 切类别子页签：回到第一页重新拉，并清掉上一个子页的勾选 */
function onExpFeeTabChange() {
  expQuery.page = 1;
  clearExpSelection();
  loadExpiring();
}

/** 筛选条件变了，勾选结果也不再可信，一并清空 */
function reloadExpiringWithClear() {
  expQuery.page = 1;
  clearExpSelection();
  loadExpiring();
}

/** 缴费状态徽章配色：已缴=绿 未缴=灰 */
function getPayPaidTagType(status: string) {
  return PAY_PAID_TAG_TYPE[status] || 'info';
}

/** 凭证状态徽章配色：已传=绿 未传=灰 被打回=红 */
function getCertTagType(status: string) {
  return CERT_STATUS_TAG_TYPE[status] || 'info';
}

/**
 * 金额展示：接口给的是「分」（规范：金额统一整数、单位分），
 * 这里除以 100 转成「元」再展示，例：580000 → ¥5,800.00
 */
function formatAmount(v?: number) {
  return v == null
    ? '-'
    : `¥${(Number(v) / 100).toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
}

/** 日期列：接口统一给 YYYY-MM-DD HH:mm:ss，列表里只展示日期部分 */
function formatDateOnly(v?: string) {
  return v ? String(v).slice(0, 10) : '-';
}

/** el-table-column 的 formatter 包装（签名固定：row, column, cellValue, index） */
function dateCell(_row: any, _column: any, cellValue: any) {
  return formatDateOnly(cellValue);
}

async function handleNotifyOne(row: ExpiringItem) {
  await notifyOne(row.paymentId);
  ElMessage.success('已发送通知');
  loadExpiring();
}

/** 一键通知：只作用于「凭证被打回」的记录（规则：被打回才能通知） */
async function handleNotifyAll() {
  const n = expStats.certRejected;
  if (n === 0) {
    ElMessage.warning(NOTIFY_NEED_REJECT_TIP);
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将向 ${n} 名凭证被打回的学生发送重新上传通知，确认执行？`,
      '提示',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  const res = await notifyAll(buildExpParams());
  ElMessage.success(`已成功通知 ${res.count} 名学生`);
  loadExpiring();
}

// ==================== 上传凭证 ====================

const uploadVisible = ref(false);
const uploadTarget = ref<ExpiringItem | null>(null);
const uploadRemark = ref('');
const uploading = ref(false);

/** 截图上传组件（换图前要把上一张清掉，limit=1） */
const shotUploadRef = ref<any>();
const shotFileName = ref('');

/** 截图识别状态机：idle → recognizing → done / partial / fail */
type OcrState = 'idle' | 'recognizing' | 'done' | 'partial' | 'fail';
const ocrState = ref<OcrState>('idle');
const ocrResult = ref<OcrResult | null>(null);
const ocrErrorText = ref('');

/** 当前是不是「凭证被打回 → 重新上传」 */
const isReupload = computed(
  () => uploadTarget.value?.certStatus === CertStatus.REJECTED,
);

const ocrLoading = computed(() => ocrState.value === 'recognizing');

/** 只读回填的两个框：识别中显示占位，识别完显示结果 */
const ocrAmountText = computed(() => {
  if (ocrState.value === 'recognizing') return '识别中…';
  return ocrResult.value?.amount == null ? '' : formatAmount(ocrResult.value.amount);
});
const ocrOrderText = computed(() => {
  if (ocrState.value === 'recognizing') return '识别中…';
  return ocrResult.value?.orderNo || '';
});

/**
 * 允许提交的条件：识别完成 且 至少识别出一项
 * —— 一张图都没认出来就提交，等于把空的金额/订单号写进去，没有意义
 */
const canSubmitUpload = computed(
  () =>
    !uploading.value &&
    (ocrState.value === 'done' || ocrState.value === 'partial') &&
    Boolean(ocrResult.value?.amount != null || ocrResult.value?.orderNo),
);

function openUpload(row: ExpiringItem) {
  uploadTarget.value = row;
  uploadRemark.value = '';
  resetOcr();
  uploadVisible.value = true;
}

/** 清空识别结果和已选截图 */
function resetOcr() {
  ocrState.value = 'idle';
  ocrResult.value = null;
  ocrErrorText.value = '';
  shotFileName.value = '';
  shotUploadRef.value?.clearFiles?.();
}

function resetUploadDialog() {
  uploadTarget.value = null;
  resetOcr();
}

/** 选了截图 → 立刻调 OCR，识别结果直接回填到（只读的）金额和订单号 */
async function onShotChange(file: any) {
  const raw = file?.raw ?? file;
  if (!raw) return;

  shotFileName.value = file?.name || '';
  ocrState.value = 'recognizing';
  ocrResult.value = null;
  ocrErrorText.value = '';

  try {
    const res = await recognizeCertificate(raw as File);
    ocrResult.value = res;
    // 金额和订单号都识别到了才算完整
    ocrState.value = res.amount != null && res.orderNo ? 'done' : 'partial';
  } catch (e: any) {
    // request.ts 已经弹过一次错误提示了，这里只负责把状态置成失败
    ocrState.value = 'fail';
    ocrErrorText.value = e?.message || OCR_FAILED_TIP;
  }
}

/** 移除截图 → 回到未识别状态，确认按钮重新禁用 */
function onShotRemove() {
  resetOcr();
  ElMessage.info(OCR_NEED_IMAGE_TIP);
}

async function submitUpload() {
  if (!uploadTarget.value) return;
  if (!canSubmitUpload.value) {
    ElMessage.warning(OCR_NEED_IMAGE_TIP);
    return;
  }

  const re = isReupload.value;
  uploading.value = true;
  try {
    const res = await uploadCertificate({
      id: uploadTarget.value.paymentId,
      certificateName: shotFileName.value || undefined,
      uploadRemark: uploadRemark.value || undefined,
      amount: ocrResult.value?.amount,
      orderNo: ocrResult.value?.orderNo || undefined,
      // ⭐ 2026-10-15：把截图地址一并提交，后端落库后回传财务
      certificateUrl: ocrResult.value?.certificateUrl,
    });

    const baseTip = re ? '凭证重新上传成功' : '凭证上传成功';
    if (res?.financeSynced) {
      ElMessage.success(`${baseTip}，已同步至财务`);
    } else {
      // 教务侧传成功了、但财务没收到 —— 必须明说，否则就是「以为传好了、财务那边没有」
      ElMessage.warning(
        `${baseTip}，但未同步至财务：${res?.financeSyncMessage || '未知原因'}`,
      );
    }
    uploadVisible.value = false;
    loadExpiring();
  } finally {
    uploading.value = false;
  }
}

// ==================== 批量上传 ====================

const batchVisible = ref(false);
const batchCount = ref(0);
const batchFileList = ref<any[]>([]);

/** 本次批量上传作用的行（勾选里可上传的那些），弹窗里列出来给教务确认 */
const batchTargets = ref<ExpiringItem[]>([]);

/** 批量上传：只处理页面上勾选的行 */
async function handleBatchUpload() {
  const ids = selectedUploadableIds.value;
  if (ids.length === 0) {
    ElMessage.warning('请先勾选需要上传凭证的记录');
    return;
  }
  batchTargets.value = expList.value.filter((r) => ids.includes(r.paymentId));
  batchCount.value = ids.length;
  batchFileList.value = [];
  batchVisible.value = true;
}

function onBatchFileChange(file: any, files: any[]) {
  batchFileList.value = files;
}

function onBatchFileRemove(_file: any, files: any[]) {
  batchFileList.value = files;
}

async function submitBatch() {
  const ids = selectedUploadableIds.value;
  if (ids.length === 0) {
    ElMessage.warning('请先勾选需要上传凭证的记录');
    return;
  }
  const res = await batchUpload({ ids });
  ElMessage.success(
    res.skipped > 0
      ? `批量上传成功：共处理 ${res.count} 条，跳过 ${res.skipped} 条`
      : `批量上传成功：共处理 ${res.count} 条记录`,
  );
  batchVisible.value = false;
  clearExpSelection();
  loadExpiring();
}

// ==================== 新建 ====================

const addVisible = ref(false);
const addFormRef = ref<FormInstance>();
const addForm = reactive({
  category: FEE_TYPES[0] as string,
  className: '',
  headTeacherName: '',
  studentNo: '',
  studentName: '',
  amount: FEE_BASE_AMOUNT[FEE_TYPES[0] as string] ?? 0,
  payStatus: PAY_PAID_STATUS_LIST[0] as string,
  payDate: '',
  expiryDate: '',
});

const addRules: FormRules = {
  studentName: [{ required: true, message: '请输入学生姓名', trigger: 'blur' }],
  payDate: [{ required: true, message: '请选择缴费时间', trigger: 'change' }],
  expiryDate: [{ required: true, message: '请选择到期时间', trigger: 'change' }],
};

/** 原型逻辑：没填班主任时，按班级下标自动落到对应的班主任 */
function onAddClassChange(cls: string) {
  if (addForm.headTeacherName) return;
  const idx = ALL_CLASSES.indexOf(cls);
  addForm.headTeacherName = HEAD_TEACHERS[idx] || '';
}

function openAdd() {
  Object.assign(addForm, {
    category: feeTab.value,
    className: '',
    headTeacherName: '',
    studentNo: '',
    studentName: '',
    amount: FEE_BASE_AMOUNT[feeTab.value] ?? 0,
    payStatus: PAY_PAID_STATUS_LIST[0] as string,
    payDate: '',
    expiryDate: '',
  });
  addVisible.value = true;
}

/** 换类别时金额跟着换成该类别的参考标准 */
function onAddCategoryChange(c: string) {
  addForm.amount = FEE_BASE_AMOUNT[c] ?? addForm.amount;
}

async function submitAdd() {
  if (!addFormRef.value) return;
  try {
    await addFormRef.value.validate();
  } catch {
    return;
  }
  await addPayment({
    category: addForm.category,
    className: addForm.className || undefined,
    headTeacherName: addForm.headTeacherName || undefined,
    studentNo: addForm.studentNo || undefined,
    studentName: addForm.studentName,
    // 表单里用户填的是「元」，接口按规范收「分」
    amount: Math.round(Number(addForm.amount || 0) * 100),
    payStatus: addForm.payStatus,
    payDate: addForm.payDate,
    expiryDate: addForm.expiryDate,
  });
  ElMessage.success('创建成功');
  addVisible.value = false;
  loadTotal();
}

// ==================== 导入 ====================

const importVisible = ref(false);
const importing = ref(false);
const importResult = ref<{ success: number; failed: number; failures: any[] } | null>(null);
let pickedFile: File | null = null;

function downloadTemplate() {
  window.open('/api/edu/payment/import-template', '_blank');
}

function onImportFileChange(file: any) {
  importResult.value = null;
  pickedFile = file?.raw || null;
}

async function submitImport() {
  if (!pickedFile) {
    ElMessage.warning('请先选择要导入的文件');
    return;
  }
  importing.value = true;
  try {
    const res = await importPayments(pickedFile);
    importResult.value = res;
    ElMessage.success(`导入完成：成功 ${res.success} 条，失败 ${res.failed} 条`);
    loadTotal();
  } finally {
    importing.value = false;
  }
}

// ==================== 初始化 ====================

function handleTabChange() {
  if (mainTab.value === 'total') loadTotal();
  else loadExpiring();
}

onMounted(() => {
  loadTotal();
  loadExpiring();
});
</script>

<style scoped>
.page-container {
  padding: 16px;
}

.main-tabs {
  background: #fff;
  padding: 0 16px;
  border-radius: 4px;
  margin-bottom: 12px;
}

.main-tabs :deep(.el-tabs__header) {
  margin-bottom: 0;
}

/* === 缴费类别子页签 === */
.sub-tabs {
  background: #fff;
  padding: 0 16px;
  border-radius: 4px;
  margin-bottom: 12px;
}

.sub-tabs :deep(.el-tabs__header) {
  margin-bottom: 0;
}

/* 子页签上的条数角标 */
.tab-count {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  min-width: 20px;
  height: 18px;
  line-height: 18px;
  border-radius: 9px;
  background: #F1EBE7;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  text-align: center;
}

.sub-tabs :deep(.el-tabs__item.is-active) .tab-count {
  background: var(--el-color-primary);
  color: #fff;
}

.empty-text {
  color: #C4B8B2;
}

/* === 统计卡片 === */
.stat-row {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.stat-card {
  flex: 1;
  min-width: 180px;
}

/* 统计卡可点击：hover 抬起 + 选中项高亮边框，提示「这张卡就是个筛选器」 */
.stat-card.clickable {
  cursor: pointer;
  transition: box-shadow 0.2s, border-color 0.2s;
}

.stat-card.clickable:hover {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}

.stat-card.clickable.is-active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary) inset;
}

.stat-card :deep(.el-card__body) {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
}

.stat-icon {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  flex-shrink: 0;
}

.stat-info {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}

.stat-num {
  font-size: 22px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.stat-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
}

.search-card {
  margin-bottom: 12px;
}

.search-card :deep(.el-form-item) {
  margin-bottom: 0;
}

.table-card :deep(.el-card__body) {
  padding: 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

/* 把「新建/导入」推到左边，「已选 N 条 + 批量操作」推到右边 */
.toolbar-gap {
  flex: 1;
}

.toolbar-hint {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-right: 4px;
}

/* 即将到期页：提示靠左、按钮靠右 */
.end-hint {
  margin-right: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.sel-on {
  color: var(--el-color-primary);
}

.batch-tip.muted {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

/* 备注列配色：≤7 天红色预警，其余橙色 */
.urgent-text {
  color: #CD3A33;
  font-weight: 500;
}

/* 到期日期后面的「剩余N天」 */
.days-left {
  display: block;
  font-size: 12px;
  line-height: 1.2;
}

.warn-text {
  color: #C9852E;
}

.done-text {
  color: #C4B8B2;
}

/* 状态列上的「系统」标记 */
.auto-tag {
  display: inline-block;
  margin-left: 4px;
  padding: 0 4px;
  height: 16px;
  line-height: 16px;
  border-radius: 2px;
  background: var(--el-color-info-light-7);
  color: var(--el-color-info);
  font-size: 11px;
  cursor: help;
}

/* 系统冻结记录的解冻入口：置灰不可点，hover 由 tooltip 说明原因 */
.btn-disabled {
  color: #C4B8B2;
  cursor: not-allowed;
  font-size: 14px;
}

.upload-info {
  padding: 10px 12px;
  background: #F6F3EF;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1.8;
}

/* 截图识别：说明文字 */
.ocr-tip {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}

.ocr-tip.muted {
  margin: 4px 0 0;
}

/* 只读回填的金额 / 订单号：让「不能手动改」这件事一眼看得出来 */
.ocr-field :deep(.el-input__inner) {
  cursor: not-allowed;
  font-weight: 600;
  color: var(--el-color-primary);
}

.batch-tip {
  margin: 0 0 14px;
  font-size: 14px;
}

.import-tip {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.import-result {
  margin-top: 14px;
}

.fail-list {
  margin: 8px 0 0;
  padding-left: 20px;
  max-height: 160px;
  overflow: auto;
  font-size: 13px;
  color: var(--el-color-danger);
  line-height: 1.8;
}
</style>
