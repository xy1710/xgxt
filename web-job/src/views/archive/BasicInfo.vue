<script setup lang="ts">
/**
 * 信息档案 - 基础信息
 *
 * 脑图要求的 12 个字段：
 *   姓名 / 学号 / 班级 / 性别 / 年龄 / 手机号 / 家长手机号
 *   宿舍号 / 入学时间 / 学历 / 简历 / 学生状态（待就业·已就业·休学·退学）
 */

import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules, type UploadRequestOptions } from 'element-plus';
import {
  Search,
  Refresh,
  Plus,
  Upload,
} from '@element-plus/icons-vue';
import {
  GENDER_NAME,
  STUDENT_STATUS_NAME,
  DEPT_NAME,
  EDUCATION_LEVELS,
  StudentStatus,
  Gender,
  DeptCode,
  RoleCode,
} from 'shared-types';
import { fetchStudentList, fetchStudentDetail, addStudent, updateStudent, deleteStudent } from '@/api/student';
// ★ 2026-10-02：学员档案弹窗（与「班级信息管理」页共用）
import StudentProfileDialog from '@/components/StudentProfileDialog.vue';
// ★ 2026-10-02：确认就业（斌哥要求从档案弹窗挪到本页操作列）
import ConfirmEmploymentDialog from '@/components/ConfirmEmploymentDialog.vue';
import { isSuperTest, myRoles } from '@/store/permission';

/* ============ 常量 ============ */

/** 就业模块只认这四种状态 */
const STATUS_OPTIONS = [
  StudentStatus.WAIT_EMPLOY,
  StudentStatus.EMPLOYED,
  StudentStatus.SUSPENDED,
  StudentStatus.QUIT,
];

const GENDER_OPTIONS = [Gender.MALE, Gender.FEMALE];
/** ★ 2026-10-20 「初高部」拆成 初中部 + 高中部（顺序 初中 → 高中 → 大学） */
const DEPT_OPTIONS = [DeptCode.JUNIOR_SENIOR, DeptCode.SENIOR, DeptCode.UNIVERSITY];
/** ★ 2026-10-04：学历改用 shared-types 的 EDUCATION_LEVELS（原来这份少了「小学」，与另两个页面不一致） */
const EDUCATION_OPTIONS = EDUCATION_LEVELS;
/** 简历单文件上限（base64 存库，别太大） */
const RESUME_MAX_SIZE = 5 * 1024 * 1024;

/* ============ 列表 ============ */

const loading = ref(false);
const tableData = ref<any[]>([]);
const total = ref(0);

const query = reactive<any>({
  page: 1,
  size: 20,
  studentNo: '',
  studentName: '',
  className: '',
  education: '',
  studentStatus: undefined,
});

async function loadData() {
  loading.value = true;
  try {
    const data = await fetchStudentList(query);
    tableData.value = data.list;
    total.value = data.total;
  } catch (e) {
    console.error('加载基础信息失败', e);
  } finally {
    loading.value = false;
  }
}

function handleSearch() {
  query.page = 1;
  loadData();
}

function handleReset() {
  query.page = 1;
  query.studentNo = '';
  query.studentName = '';
  query.className = '';
  query.education = '';
  query.studentStatus = undefined;
  loadData();
}

/* ============ 详情 ============ */

// ★ 2026-10-02（斌哥："班级信息管理和信息档案重复了"）：
//   详情改用**公共组件** StudentProfileDialog —— 与「班级信息管理」页同一套多 Tab 档案。
//   原来自己画的抽屉只有十几个基础字段，看不到就业日志 / 复盘 / 考试 / 宿舍 / 缴费。
const profileVisible = ref(false);
const profileStudentId = ref('');

function handleDetail(row: any): void {
  profileStudentId.value = row.studentId;
  profileVisible.value = true;
}

/* ============ 确认就业（★ 2026-10-02 从档案弹窗挪到本页操作列）============
 *
 * 【为什么放这儿】
 *   斌哥要求：确认就业这个动作属于"就业管理"的日常操作，
 *   应该跟 详情/编辑/删除 并排放在列表操作列里，不用点开档案再找。
 *
 * 【谁能点】就业老师 / 校长 / 学管主任（与后端白名单一致）
 * 【什么时候显示】学生状态 = 待就业(9) 时
 * ============================================================ */
const CONFIRM_EMPLOY_ROLES: string[] = [
  RoleCode.JOB_STAFF,
  RoleCode.RM_PRINCIPAL,
  RoleCode.TEACH_DEAN,
];
const canConfirmEmploy = computed(() =>
  // ★ 万能测试号：业务验证用，全部放行
  isSuperTest.value || myRoles.value.some((r) => CONFIRM_EMPLOY_ROLES.includes(r)),
);

const employVisible = ref(false);
const employRow = ref<any>(null);

function handleConfirmEmploy(row: any): void {
  employRow.value = row;
  employVisible.value = true;
}

/* ============ 新增 / 编辑 ============ */

const dialogVisible = ref(false);
const isEdit = ref(false);
const submitting = ref(false);
const formRef = ref<FormInstance>();

const defaultForm = {
  id: '',
  studentNo: '',
  studentName: '',
  gender: Gender.MALE,
  age: undefined as number | undefined,
  deptCode: DeptCode.UNIVERSITY,
  className: '',
  studentStatus: StudentStatus.WAIT_EMPLOY,
  phone: '',
  parentPhone: '',
  education: '',
  enrollDate: '',
  remark: '',
  resumeName: '',
  resumeData: '',
};

const form = reactive({ ...defaultForm });

const rules: FormRules = {
  studentNo: [{ required: true, message: '请输入学号', trigger: 'blur' }],
  studentName: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  gender: [{ required: true, message: '请选择性别', trigger: 'change' }],
  deptCode: [{ required: true, message: '请选择部门', trigger: 'change' }],
  studentStatus: [{ required: true, message: '请选择学生状态', trigger: 'change' }],
  phone: [{ pattern: /^1[3-9]\d{9}$/, message: '手机号格式不正确', trigger: 'blur' }],
  parentPhone: [{ pattern: /^1[3-9]\d{9}$/, message: '家长手机号格式不正确', trigger: 'blur' }],
};

function handleAdd() {
  isEdit.value = false;
  Object.assign(form, defaultForm);
  dialogVisible.value = true;
}

async function handleEdit(row: any) {
  isEdit.value = true;
  try {
    const data = await fetchStudentDetail(row.studentId);
    Object.assign(form, {
      id: data.id,
      studentNo: data.studentNo,
      studentName: data.studentName,
      gender: data.gender,
      age: data.age,
      deptCode: data.deptCode,
      className: data.className || '',
      studentStatus: data.studentStatus,
      phone: data.phone || '',
      parentPhone: data.parentPhone || '',
      education: data.education || '',
      enrollDate: data.enrollDate || '',
      remark: data.remark || '',
      resumeName: data.resumeName || '',
      resumeData: data.resumeData || '',
    });
    dialogVisible.value = true;
  } catch (e) {
    console.error(e);
  }
}

/* ============ 简历上传 ============ */

const uploading = ref(false);

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

async function handleResumeUpload(options: UploadRequestOptions) {
  const file = options.file as File;
  if (file.size > RESUME_MAX_SIZE) {
    ElMessage.warning(`简历不能超过 5MB，当前文件 ${(file.size / 1024 / 1024).toFixed(2)}MB`);
    return;
  }
  uploading.value = true;
  try {
    form.resumeData = await readFileAsDataUrl(file);
    form.resumeName = file.name;
    ElMessage.success('简历已就绪，点「确定」保存');
  } catch (e) {
    ElMessage.error('简历读取失败');
  } finally {
    uploading.value = false;
  }
}

function removeResume() {
  form.resumeName = '';
  form.resumeData = '';
}

/** 预览简历（dataURL 直接开新窗口即可） */
function previewResume(name?: string, data?: string) {
  if (!data) return;
  const win = window.open();
  if (!win) {
    ElMessage.warning('浏览器拦截了新窗口，请允许弹出窗口后重试');
    return;
  }
  if (data.startsWith('data:image')) {
    win.document.write(`<title>${name || '简历'}</title><img src="${data}" style="max-width:100%" />`);
  } else {
    win.location.href = data;
  }
}

/* ============ 提交 ============ */

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  submitting.value = true;
  try {
    const payload = {
      id: form.id,
      studentNo: form.studentNo,
      studentName: form.studentName,
      gender: form.gender,
      age: form.age,
      deptCode: form.deptCode,
      className: form.className,
      studentStatus: form.studentStatus,
      phone: form.phone,
      parentPhone: form.parentPhone,
      education: form.education,
      enrollDate: form.enrollDate,
      remark: form.remark,
      resumeName: form.resumeName,
      resumeData: form.resumeData,
    };
    if (isEdit.value) {
      await updateStudent(payload as any);
      ElMessage.success('修改成功');
    } else {
      await addStudent(payload as any);
      ElMessage.success('新增成功');
    }
    dialogVisible.value = false;
    loadData();
  } catch (e) {
    // 错误提示已统一处理
  } finally {
    submitting.value = false;
  }
}

/* ============ 删除 ============ */

async function handleDelete(row: any) {
  try {
    await ElMessageBox.confirm(
      `确定要删除学生「${row.studentName}（${row.studentNo}）」吗？删除后可从回收站恢复逻辑删除标记。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await deleteStudent(row.studentId);
    ElMessage.success('删除成功');
    loadData();
  } catch (e) {
    // 统一处理
  }
}

/* ============ 小工具 ============ */

function statusTagType(status: number) {
  if (status === StudentStatus.EMPLOYED) return 'success';
  if (status === StudentStatus.WAIT_EMPLOY) return 'primary';
  if (status === StudentStatus.SUSPENDED) return 'warning';
  return 'danger';
}

onMounted(loadData);
</script>

<template>
  <div class="page-container">
    <!-- ============ 搜索 ============ -->
    <el-card shadow="never" class="search-card">
      <el-form :model="query" inline>
        <el-form-item label="学号">
          <el-input v-model="query.studentNo" placeholder="请输入学号" clearable style="width: 150px" @keyup.enter="handleSearch" />
        </el-form-item>
        <el-form-item label="姓名">
          <el-input v-model="query.studentName" placeholder="请输入姓名" clearable style="width: 150px" @keyup.enter="handleSearch" />
        </el-form-item>
        <el-form-item label="班级">
          <el-input v-model="query.className" placeholder="请输入班级" clearable style="width: 140px" @keyup.enter="handleSearch" />
        </el-form-item>
        <el-form-item label="学历">
          <el-select v-model="query.education" placeholder="全部" clearable style="width: 120px">
            <el-option v-for="e in EDUCATION_OPTIONS" :key="e" :label="e" :value="e" />
          </el-select>
        </el-form-item>
        <el-form-item label="学生状态">
          <el-select v-model="query.studentStatus" placeholder="全部" clearable style="width: 130px">
            <el-option
              v-for="s in STATUS_OPTIONS"
              :key="s"
              :label="STUDENT_STATUS_NAME[s]"
              :value="s"
            />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="handleSearch">查询</el-button>
          <el-button :icon="Refresh" @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- ============ 表格 ============ -->
    <el-card shadow="never" class="table-card">
      <div class="toolbar">
        <el-button type="primary" :icon="Plus" @click="handleAdd">新增学生</el-button>
        <span class="tip">就业模块仅展示：待就业 / 已就业 / 休学 / 退学 四类学生</span>
      </div>

      <el-table v-loading="loading" :data="tableData" border stripe style="width: 100%" empty-text="暂无数据">
        <el-table-column type="index" label="序号" width="60" align="center" />
        <el-table-column prop="studentNo" label="学号" width="120" />
        <el-table-column prop="studentName" label="姓名" width="90" />
        <el-table-column prop="genderName" label="性别" width="70" align="center" />
        <el-table-column prop="age" label="年龄" width="70" align="center">
          <template #default="{ row }">{{ row.age ?? '—' }}</template>
        </el-table-column>
        <el-table-column prop="className" label="班级" width="110">
          <template #default="{ row }">{{ row.className || '—' }}</template>
        </el-table-column>
        <el-table-column prop="phone" label="手机号" width="130">
          <template #default="{ row }">{{ row.phone || '—' }}</template>
        </el-table-column>
        <el-table-column prop="parentPhone" label="家长手机号" width="130">
          <template #default="{ row }">{{ row.parentPhone || '—' }}</template>
        </el-table-column>
        <el-table-column prop="dormNo" label="宿舍号" width="100">
          <template #default="{ row }">{{ row.dormNo || '未分配' }}</template>
        </el-table-column>
        <el-table-column prop="enrollDate" label="入学时间" width="120">
          <template #default="{ row }">{{ row.enrollDate || '—' }}</template>
        </el-table-column>
        <el-table-column prop="education" label="学历" width="80">
          <template #default="{ row }">{{ row.education || '—' }}</template>
        </el-table-column>
        <el-table-column label="简历" width="150">
          <template #default="{ row }">
            <el-button
              v-if="row.resumeName"
              link
              type="primary"
              size="small"
              @click="handleDetail(row)"
            >
              {{ row.resumeName }}
            </el-button>
            <span v-else class="muted">未上传</span>
          </template>
        </el-table-column>
        <el-table-column label="学生状态" width="100" align="center" fixed="right">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.studentStatus)" size="small">
              {{ row.studentStatusName }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="235" fixed="right" align="center">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="handleDetail(row)">详情</el-button>
            <el-button link type="primary" size="small" @click="handleEdit(row)">编辑</el-button>
            <!-- ★ 2026-10-02：待就业的学生可以直接在这里确认就业（不用点开档案再找） -->
            <el-button
              v-if="canConfirmEmploy && row.studentStatus === StudentStatus.WAIT_EMPLOY"
              link
              type="success"
              size="small"
              @click="handleConfirmEmploy(row)"
            >
              确认就业
            </el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.size"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        layout="total, sizes, prev, pager, next, jumper"
        style="margin-top: 16px; justify-content: flex-end"
        @size-change="loadData"
        @current-change="loadData"
      />
    </el-card>

    <!-- ============ 新增 / 编辑弹窗 ============ -->
    <el-dialog v-model="dialogVisible" :title="isEdit ? '编辑学生档案' : '新增学生档案'" width="640px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="学号" prop="studentNo">
              <el-input v-model="form.studentNo" placeholder="如 S20260001" :disabled="isEdit" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="姓名" prop="studentName">
              <el-input v-model="form.studentName" placeholder="请输入姓名" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="性别" prop="gender">
              <el-radio-group v-model="form.gender">
                <el-radio v-for="g in GENDER_OPTIONS" :key="g" :value="g">{{ GENDER_NAME[g] }}</el-radio>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="年龄" prop="age">
              <el-input-number v-model="form.age" :min="10" :max="60" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="部门" prop="deptCode">
              <el-select v-model="form.deptCode" style="width: 100%">
                <el-option v-for="d in DEPT_OPTIONS" :key="d" :label="DEPT_NAME[d]" :value="d" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="班级" prop="className">
              <el-input v-model="form.className" placeholder="如 就业1班" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="手机号" prop="phone">
              <el-input v-model="form.phone" placeholder="请输入手机号" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="家长手机号" prop="parentPhone">
              <el-input v-model="form.parentPhone" placeholder="请输入家长手机号" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="入学时间" prop="enrollDate">
              <el-date-picker
                v-model="form.enrollDate"
                type="date"
                value-format="YYYY-MM-DD"
                placeholder="选择日期"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="学历" prop="education">
              <el-select v-model="form.education" placeholder="请选择" clearable style="width: 100%">
                <el-option v-for="e in EDUCATION_OPTIONS" :key="e" :label="e" :value="e" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="学生状态" prop="studentStatus">
              <el-select v-model="form.studentStatus" style="width: 100%">
                <el-option v-for="s in STATUS_OPTIONS" :key="s" :label="STUDENT_STATUS_NAME[s]" :value="s" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="简历">
              <div class="resume-box">
                <el-upload
                  v-if="!form.resumeName"
                  :http-request="handleResumeUpload"
                  :show-file-list="false"
                  accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
                >
                  <el-button type="primary" :loading="uploading" :icon="Upload">上传简历</el-button>
                  <template #tip>
                    <div class="el-upload__tip">支持 pdf / doc / docx / 图片，单个文件 ≤ 5MB</div>
                  </template>
                </el-upload>
                <div v-else class="resume-file">
                  <span class="resume-name">{{ form.resumeName }}</span>
                  <el-button link type="primary" size="small" @click="previewResume(form.resumeName, form.resumeData)">预览</el-button>
                  <el-button link type="danger" size="small" @click="removeResume">移除</el-button>
                </div>
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="备注">
              <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="特殊情况备注" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">确定</el-button>
      </template>
    </el-dialog>

    <!-- ============ 学员档案（公共组件 · 多 Tab）============ -->
    <!-- ★ 2026-10-02：与「班级信息管理」页共用同一套档案弹窗（改一次两边都生效） -->
    <StudentProfileDialog
      v-model:visible="profileVisible"
      :student-id="profileStudentId"
      @updated="loadData"
    />

    <!-- ★ 2026-10-02：确认就业（待就业 → 已就业），入口在列表操作列 -->
    <ConfirmEmploymentDialog
      v-model:visible="employVisible"
      :student-id="employRow?.studentId || ''"
      :student-name="employRow?.studentName"
      :student-no="employRow?.studentNo"
      @done="loadData"
    />
  </div>
</template>

<style scoped>
.page-container {
  padding: 16px;
}

.search-card {
  margin-bottom: 12px;
}

.search-card :deep(.el-form-item) {
  margin-bottom: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.tip {
  font-size: 12px;
  color: #A2938E;
}

.muted {
  color: #C4B8B2;
}

.resume-box {
  width: 100%;
}

.resume-file {
  display: flex;
  align-items: center;
  gap: 8px;
}

.resume-name {
  font-size: 13px;
  color: #7A6C67;
}
</style>
