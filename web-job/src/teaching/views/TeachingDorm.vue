<template>
  <div class="tdv">
    <el-tabs v-model="mainTab" class="tdv-main-tabs">
      <el-tab-pane label="宿舍房间" name="rooms">
    <!-- 说明条 -->
    <el-alert class="tdv-tip" type="info" :closable="false" show-icon>
      <template #title>
        本页合并了 <b>3 个学段</b>的宿舍（初高 / 大学 / 实训），不再按学段分开看。
        <span class="muted">
          类别分「男寝 / 女寝」；宿舍号是 <b>3 位数字</b>，第 1 位是楼层、后 2 位是房号（如 308 = 3 楼 08 室）；
          楼栋只认「系统设置 → 楼栋设置」里维护过的；
          <b>关键字搜全部列</b>（类别 / 楼栋 / 宿舍号 / 状态 / 备注都能搜）；
          <b>已住人数是实时统计的</b>，不信任表里的冗余列，所以改了床位立刻见效。
        </span>
      </template>
    </el-alert>

    <!--
      筛选栏（2026-10-18 改版）
      · 顺序固定：关键字 → 类别 → 楼栋 → 状态 → 入住率
      · 【删掉了「学段」下拉】三个学段合并展示，再拿学段筛一次是重复信息，
        而且会让用户以为「还有第二个学段页面没打开」。
      · 【删掉了「只看有空床」复选框】入住率筛选已经能覆盖它（选 0~99% 就是有空床），
        两个开关表达同一件事，留着只会互相打架。
      · 关键字是全局搜索：类别/楼栋/宿舍号/已住·床位/入住率/状态/备注 **全都搜**
        （后端按列表显示值匹配，所以搜「男寝」「停用」也能命中）。
    -->
    <el-form class="tdv-filter" inline>
      <el-form-item label="关键字">
        <el-input
          v-model="query.keyword"
          placeholder="搜全部：类别 / 楼栋 / 宿舍号 / 状态 / 备注"
          clearable
          style="width: 240px"
          @keyup.enter="load(1)"
        />
      </el-form-item>
      <el-form-item label="类别">
        <el-select v-model="query.dormType" clearable placeholder="全部" style="width: 110px">
          <el-option
            v-for="d in DORM_CATEGORY_OPTIONS"
            :key="d.value"
            :label="d.label"
            :value="d.value"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="楼栋">
        <el-select v-model="query.building" clearable placeholder="全部楼栋" style="width: 140px">
          <el-option v-for="b in buildings" :key="b.value" :label="b.label" :value="b.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="状态">
        <el-select v-model="query.roomStatus" clearable placeholder="全部" style="width: 110px">
          <el-option
            v-for="d in DORM_ROOM_STATUS_OPTIONS"
            :key="d.value"
            :label="d.label"
            :value="d.value"
          />
        </el-select>
      </el-form-item>
      <!-- ★ 入住率：选项后端实时算，不写死档位 -->
      <el-form-item label="入住率">
        <el-select
          v-model="query.occupancyRate"
          clearable
          placeholder="全部"
          style="width: 110px"
        >
          <el-option v-for="r in occupancyRates" :key="r.value" :label="r.label" :value="r.value" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="load(1)">查询</el-button>
        <el-button @click="reset">重置</el-button>
        <!-- ★ 班主任不建房间（房间由教务/学管统一建） -->
        <el-button v-if="canCreate && !isOnlyHeadTeacher" type="success" @click="openCreate">新增房间</el-button>
        <el-button type="warning" @click="openChange">调宿/退宿申请</el-button>
      </el-form-item>
    </el-form>

    <!-- 房间列表 -->
    <!--
      ★ 列表列（2026-10-16 改版）
        类别 / 楼栋 / 宿舍号 / 已住-床位 / 入住率 / 状态 / 备注 / 操作
        原来的「学段 / 楼层 / 所属班级 / 负责人」四列已按要求去掉：
        学段改由顶部筛选器承担（列里再显示一次是重复信息），
        楼层不再单列 —— 宿舍号第 1 位就是楼层。
    -->
    <el-table v-loading="loading" :data="rows" border stripe size="small">
      <el-table-column label="类别" width="80" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="row.dormType === 2 ? 'danger' : 'primary'" effect="plain">
            {{ categoryName(row) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="楼栋" width="120">
        <template #default="{ row }">{{ row.buildingName || '—' }}</template>
      </el-table-column>
      <el-table-column label="宿舍号" min-width="120">
        <template #default="{ row }">
          <a class="link" @click="openBeds(row)">{{ row.roomNo }}</a>
        </template>
      </el-table-column>
      <!-- ★「已住/床位」合成一列：入住情况一眼看完，不用左右对两列 -->
      <el-table-column label="已住/床位" width="100" align="center">
        <template #default="{ row }">
          <b :class="row.occupiedCount >= row.bedCount ? 'danger' : 'ok'">
            {{ row.occupiedCount }}
          </b>
          <span class="muted"> / {{ row.bedCount }}</span>
        </template>
      </el-table-column>
      <el-table-column label="入住率" width="90" align="center">
        <template #default="{ row }">
          <span :class="rateClass(row)">{{ row.occupancyRate }}%</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90" align="center">
        <template #default="{ row }">
          <el-tag :type="DORM_STATUS_TAG[row.roomStatus] || 'info'" size="small">
            {{ row.roomStatusName }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="备注" min-width="140" show-overflow-tooltip>
        <template #default="{ row }">{{ row.remark || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="170" fixed="right" align="center">
        <template #default="{ row }">
          <el-button link type="primary" @click="openBeds(row)">床位</el-button>
          <el-button v-if="canEdit(row) && !isOnlyHeadTeacher" link type="primary" @click="openEdit(row)">编辑</el-button>
          <!--
            ★ 删除的前置条件：房间里没有入住学生（2026-10-19）
              住着人的房间直接禁用删除按钮 —— 与其让用户点了再吃一个报错，
              不如在按钮上就把话说清楚。后端 repo.remove() 还会再拦一次（双保险）。
          -->
          <el-tooltip
            v-if="canEdit(row) && !isOnlyHeadTeacher && row.occupiedCount > 0"
            content="该宿舍有学生入住，不能删除；请先办理退宿"
            placement="top"
          >
            <span><el-button link type="danger" disabled>删除</el-button></span>
          </el-tooltip>
          <el-button v-else-if="canEdit(row) && !isOnlyHeadTeacher" link type="danger" @click="doDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="tdv-page"
      layout="total, sizes, prev, pager, next"
      :total="total"
      :current-page="query.page"
      :page-size="query.size"
      :page-sizes="[10, 20, 50, 100]"
      @current-change="load"
      @size-change="load(1)"
    />

    <!-- ============ 床位抽屉 ============ -->
    <el-drawer v-model="bedVisible" :title="`${curDorm?.buildingName || ''} ${curDorm?.roomNo || ''} · 床位`" size="620px">
      <template v-if="curDorm">
        <!-- ★ 大学没有独立床位表，床位是按入住顺序虚拟编号的，必须说清楚 -->
        <el-alert
          v-if="curMeta && !curMeta.hasBedTable"
          type="warning"
          :closable="false"
          show-icon
          title="大学的床位数据由教务同步，没有真实床位号；这里按入住顺序排列为「编号1、编号2…」"
        />
        <el-alert
          v-else-if="curMeta && !curMeta.hasCreate"
          type="info"
          :closable="false"
          show-icon
          title="该学段的宿舍数据由教务同步，不能在这里分派/退宿；请走「调宿/退宿申请」"
        />

        <div class="tdv-bed-head">
          <el-tag :type="DORM_STATUS_TAG[curDorm.roomStatus] || 'info'">
            {{ curDorm.roomStatusName }}
          </el-tag>
          <el-tag size="small" effect="plain">{{ categoryName(curDorm) }}</el-tag>
          <span class="muted">
            床位 {{ curDorm.bedCount }} · 已住 {{ curDorm.occupiedCount }} · 空床
            {{ curDorm.bedCount - curDorm.occupiedCount }}
          </span>
        </div>

        <el-divider content-position="left">床位一览</el-divider>
        <div class="tdv-beds">
          <div
            v-for="b in beds"
            :key="b.bedId || b.bedNo"
            class="tdv-bed"
            :class="{ 'is-free': b.bedStatus === 1, 'is-used': b.bedStatus === 2 }"
          >
            <div class="tdv-bed__no">{{ b.bedLabel }}</div>
            <div class="tdv-bed__who">
              <template v-if="b.studentName">
                <b>{{ b.studentName }}</b>
                <span class="muted">{{ b.studentNo }}</span>
              </template>
              <span v-else class="muted">{{ b.bedStatusName }}</span>
            </div>
            <div class="tdv-bed__ops">
              <el-button
                v-if="b.bedStatus === 1 && canEdit(curDorm)"
                link
                type="primary"
                size="small"
                @click="openAssign(b)"
              >
                入住
              </el-button>
              <el-button
                v-if="b.bedStatus === 2 && canEdit(curDorm)"
                link
                type="warning"
                size="small"
                @click="doCheckout(b)"
              >
                退宿
              </el-button>
            </div>
          </div>
          <el-empty v-if="!beds.length" description="该房间还没有床位记录" :image-size="70" />
        </div>

        <template v-if="residentsOfCur.length">
          <el-divider content-position="left">在住名单（{{ residentsOfCur.length }} 人）</el-divider>
          <el-table :data="residentsOfCur" border size="small">
            <el-table-column label="床位" prop="bedLabel" width="90" />
            <el-table-column label="学号" prop="studentNo" width="110" />
            <el-table-column label="姓名" prop="studentName" />
            <el-table-column label="性别" prop="genderName" width="60" align="center" />
            <el-table-column label="入住日期" prop="checkInDate" width="110" align="center" />
          </el-table>
        </template>
      </template>
    </el-drawer>

    <!-- ============ 新增 / 编辑房间 ============ -->
    <el-dialog
      v-model="editVisible"
      :title="form.id ? '编辑房间' : '新增房间'"
      width="480px"
      top="8vh"
      destroy-on-close
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <!-- ① 类别：单选框，只有 男寝 / 女寝 两项（没有「不限」） -->
        <el-form-item label="类别" prop="dormType" required>
          <el-radio-group v-model="form.dormType">
            <el-radio v-for="d in DORM_CATEGORY_OPTIONS" :key="d.value" :value="d.value">
              {{ d.label }}
            </el-radio>
          </el-radio-group>
        </el-form-item>

        <!-- ② 楼栋：下拉，选项按类别联动 -->
        <el-form-item label="楼栋" prop="buildingName" required>
          <el-select v-model="form.buildingName" placeholder="请先选择类别" style="width: 100%">
            <el-option
              v-for="b in buildingOptions"
              :key="b.value"
              :label="b.label"
              :value="b.value"
            />
          </el-select>
          <div class="tdv-hint">
            只显示与「类别」一致的楼栋；如没有，请先去「系统设置 → 楼栋设置」维护
          </div>
        </el-form-item>

        <!-- ③ 宿舍号：3 位数字，第 1 位楼层 + 后 2 位房号 -->
        <el-form-item label="宿舍号" prop="roomNo" required>
          <el-input
            v-model="form.roomNo"
            maxlength="3"
            placeholder="如 308"
            style="width: 100%"
            @input="form.roomNo = form.roomNo.replace(/\D/g, '')"
          />
          <div class="tdv-hint">
            3 位数字：第 1 位是楼层、后 2 位是房号
            <template v-if="roomNoFloor"> → 当前 {{ roomNoFloor }} 楼</template>
          </div>
        </el-form-item>

        <!-- ④ 床位数：1~50（已住人数由系统实时统计，不在这里填） -->
        <el-form-item label="床位数" prop="bedCount">
          <el-input-number
            v-model="form.bedCount"
            :min="1"
            :max="DORM_BED_COUNT_MAX"
            :step="1"
            step-strictly
            style="width: 100%"
          />
          <div class="tdv-hint">取值范围 1 ~ {{ DORM_BED_COUNT_MAX }}</div>
        </el-form-item>

        <!-- ⑤ 状态：只有 使用中 / 停用 -->
        <el-form-item label="状态">
          <el-select v-model="form.roomStatus" style="width: 100%">
            <el-option
              v-for="d in DORM_ROOM_STATUS_OPTIONS"
              :key="d.value"
              :label="d.label"
              :value="d.value"
            />
          </el-select>
        </el-form-item>

        <!-- ⑥ 备注：≤ 50 个汉字 -->
        <el-form-item label="备注" prop="remark">
          <el-input
            v-model="form.remark"
            type="textarea"
            :rows="2"
            :maxlength="DORM_REMARK_MAX"
            show-word-limit
            placeholder="选填，最多 50 个汉字"
          />
        </el-form-item>

        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="入住率 = 已住人数 / 床位数，已住人数由床位实时统计，不用手工填；保存后系统会自动生成对应数量的床位行。"
        />
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doSave">保存</el-button>
      </template>
    </el-dialog>

    <!-- ============ 入住 ============ -->
    <el-dialog v-model="assignVisible" title="办理入住" width="480px">
      <el-form label-width="90px">
        <el-form-item label="房间">
          <span>{{ curDorm?.buildingName }} {{ curDorm?.roomNo }}</span>
        </el-form-item>
        <el-form-item label="床位">
          <span>{{ assignBedRow?.bedLabel }}</span>
        </el-form-item>
        <el-form-item label="学生" required>
          <el-select
            v-model="assignStudentId"
            filterable
            remote
            clearable
            reserve-keyword
            :remote-method="searchAssignStudents"
            :loading="assignLoading"
            placeholder="输入学号或姓名搜索（本班未入住学生）"
            style="width: 100%"
            @change="onAssignStudentChange"
          >
            <el-option
              v-for="c in assignOptions"
              :key="c.studentId"
              :label="`${c.studentName}（${c.studentNo}）${c.className ? ' · ' + c.className : ''}`"
              :value="c.studentId"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="入住日期">
          <el-date-picker v-model="assignDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="assignVisible = false">取消</el-button>
        <el-button type="primary" :loading="assigning" @click="doAssign">确认入住</el-button>
      </template>
    </el-dialog>

    <!-- ============ 调宿 / 退宿申请 ============ -->
    <!--
      ★ 2026-10-20 改版（按需求重排）：
        ① 去掉「学段」——三个学段本来就合并了，再选一次是重复信息；
        ② 第一排：类型（调换宿舍 / 退宿）；
        ③ 第二排：班级（来自班级管理已建班级）；
        ④ 学生改成**搜索框**（姓名/学号前后模糊），选项显示「姓名（学号）」区分重名；
           班级与学生联动：选了班级只搜这个班的学生；
        ⑤ 选学生后自动显示当前宿舍位置；
        ⑥ 调换宿舍：先选类别（男寝/女寝）→ 楼栋 → 目标床位（下拉列出各宿舍空床位）；
        ⑦ 日期自动取当天、只读；原因必填、≤100 字。
    -->
    <el-dialog v-model="changeVisible" title="发起调宿 / 退宿申请" width="680px" top="6vh">
      <el-form label-width="100px">
        <!-- 第一排：类型 -->
        <el-form-item label="类型" required>
          <el-radio-group v-model="changeForm.bizType" @change="onChangeBizType">
            <el-radio :value="1">调换宿舍</el-radio>
            <el-radio :value="2">退宿</el-radio>
          </el-radio-group>
        </el-form-item>

        <!-- 第二排：班级 -->
        <el-form-item label="班级" required>
          <el-select
            v-model="changeForm.className"
            filterable
            clearable
            placeholder="选择班级"
            style="width: 100%"
            @change="onChangeClass"
          >
            <el-option v-for="c in changeClasses" :key="c.className" :label="c.className" :value="c.className" />
          </el-select>
        </el-form-item>

        <!-- 学生：搜索框（姓名 / 学号前后模糊） -->
        <el-form-item label="学生" required>
          <el-select
            v-model="changeForm.studentId"
            filterable
            remote
            clearable
            reserve-keyword
            :remote-method="searchChangeStudents"
            :loading="studentLoading"
            placeholder="输入姓名或学号搜索"
            style="width: 100%"
            @change="onChangeStudent"
          >
            <el-option
              v-for="s in changeStudents"
              :key="s.studentId"
              :label="`${s.studentName}（${s.studentNo}）`"
              :value="s.studentId"
            />
          </el-select>
        </el-form-item>

        <!-- 当前宿舍位置（选学生后自动显示：楼栋 / 宿舍号 / 床位号） -->
        <el-form-item v-if="curStudent" label="当前宿舍">
          <div v-if="curStudent.dormId || curStudent.dormNo || curStudent.bedNo" class="cur-dorm">
            <span>楼栋：<b>{{ curStudent.building || '—' }}</b></span>
            <span>宿舍号：<b>{{ curStudent.room || '—' }}</b></span>
            <span>床位号：<b>{{ curStudent.bedLabel || curStudent.bedNo || '—' }}</b></span>
          </div>
          <el-tag v-else type="info" size="small">该学生当前未入住宿舍</el-tag>
        </el-form-item>

        <!-- 调换宿舍：类别 → 楼栋 → 空床位 -->
        <template v-if="changeForm.bizType === 1">
          <el-form-item label="类别" required>
            <el-radio-group v-model="changeForm.category" @change="onChangeCategory">
              <el-radio :value="1">男寝</el-radio>
              <el-radio :value="2">女寝</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="楼栋" required>
            <el-select v-model="changeForm.building" placeholder="选择楼栋" style="width: 100%" @change="loadChangeRooms">
              <el-option v-for="b in changeBuildings" :key="b" :label="b" :value="b" />
            </el-select>
          </el-form-item>
          <el-form-item label="目标床位" required>
            <el-select
              v-model="changeForm.targetBedId"
              filterable
              :disabled="!changeForm.building"
              :placeholder="changeForm.building ? '选择空余床位（宿舍 · 床位）' : '请先选择楼栋'"
              style="width: 100%"
              :loading="changeRoomsLoading"
            >
              <el-option-group v-for="r in changeRoomsWithBeds" :key="r.roomId" :label="`${r.building} ${r.room}（余 ${r.remaining} 床）`">
                <el-option
                  v-for="b in r.freeBeds"
                  :key="b.bedId"
                  :label="`${r.building} ${r.room} · ${b.bedLabel}`"
                  :value="b.bedId"
                />
              </el-option-group>
            </el-select>
            <div v-if="changeForm.building && !changeRoomsWithBeds.length && !changeRoomsLoading" class="tdv-hint">
              该楼栋暂无空余床位
            </div>
          </el-form-item>
        </template>

        <!-- 日期：当天，只读 -->
        <el-form-item label="日期">
          <span class="tdv-date">{{ changeForm.changeDate }}</span>
          <el-text type="info" size="small" class="ml12">自动取当天日期，不可修改</el-text>
        </el-form-item>

        <el-form-item label="原因" required>
          <el-input
            v-model="changeForm.changeReason"
            type="textarea"
            :rows="3"
            maxlength="100"
            show-word-limit
            placeholder="请填写调宿 / 退宿原因（不超过 100 字）"
          />
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="提交后进入审批流：班主任发起 → 教务老师 1 步审批。三个学段审批链已统一。"
      />
      <template #footer>
        <el-button @click="changeVisible = false">取消</el-button>
        <el-button type="primary" :loading="changeSaving" @click="doCreateChange">提交申请</el-button>
      </template>
    </el-dialog>

    <!-- ============ 申请列表 ============ -->
    <el-dialog v-model="changeListVisible" title="调宿 / 退宿申请" width="900px" top="6vh">
      <el-table v-loading="changeLoading" :data="changes" border size="small">
        <el-table-column label="学段" width="70" align="center">
          <template #default="{ row }">{{ row.stageName }}</template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">{{ row.bizTypeName }}</template>
        </el-table-column>
        <el-table-column label="学生" min-width="140">
          <template #default="{ row }">
            {{ row.studentName || '—' }}
            <span class="muted">{{ row.studentNo }}</span>
          </template>
        </el-table-column>
        <el-table-column label="原宿舍" min-width="110">
          <template #default="{ row }">{{ row.oldDormNo || '—' }}</template>
        </el-table-column>
        <el-table-column label="新宿舍" min-width="110">
          <template #default="{ row }">{{ row.newDormNo || '—' }}</template>
        </el-table-column>
        <el-table-column label="日期" width="105" align="center">
          <template #default="{ row }">{{ row.changeDate }}</template>
        </el-table-column>
        <el-table-column label="原因" min-width="140">
          <template #default="{ row }">{{ row.changeReason || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="DORM_APPROVAL_TAG[row.approvalStatus] || 'info'" size="small">
              {{ row.approvalStatusName }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-alert
        class="tdv-change-tip"
        type="info"
        :closable="false"
        show-icon
        title="审批动作在「宿舍管理 → 申请审批」里处理，这里只做查询。"
      />
    </el-dialog>
      </el-tab-pane>

      <!-- ★ 2026-10-20 新增：教务给各班分派宿舍（左右两栏男寝 / 女寝）
           ★ 2026-10-21：班主任不显示该子页面（班级层面的分派归教务） -->
      <el-tab-pane v-if="!isOnlyHeadTeacher" label="班级分派" name="allocate" lazy>
        <DormAllocate />
      </el-tab-pane>

      <!-- ★ 2026-10-21：申请审批（班主任提交的换宿/退宿单；通过后自动改床位与学生宿舍） -->
      <el-tab-pane v-if="canApproveDorm" label="申请审批" name="approval" lazy>
        <DormChangeApproval />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
/**
 * 统一宿舍管理页（第 2 期 · 最后一个业务域）
 * ============================================================
 *
 * 合并了 3 个学段（初高 / 大学 / 实训）的宿舍管理：
 *   · 一个页面 + 学段筛选（原来 3 个页面，共 3415 行）
 *   · 主列表 = 房间；点行开抽屉看床位（楼栋做成筛选下拉，不做树）
 *
 * 【★★ 两个必须记住的约束】
 *
 * ① **大学的宿舍是只读的**（斌哥 2026-10-09 拍板）
 *    大学的房间/床位是从教务同步进 sms_common 两张表的，不是自己维护的。
 *    → `/meta` 下发的 hasCreate=false，前端隐藏新增/编辑/删除/入住/退宿；
 *    → 后端还会再拦一次（双保险，防前端漏改）。
 *    → 但「换宿/退宿申请」照常给。
 *
 * ② **大学的床位是虚拟编号**
 *    大学没有独立床位表，live_sync 是「一人一条在住记录」，没有真实床位号。
 *    → 抽屉里用「编号1、编号2…」并明确提示，别让用户以为是真床位号。
 *
 * 【★ 2026-10-16 改版：列表列与新增房间规则重构】
 *
 *   列表列固定为 8 列（不再按学段动态增删）：
 *     类别 / 楼栋 / 宿舍号 / 已住-床位 / 入住率 / 状态 / 备注 / 操作
 *
 *   新增房间弹窗（学段已在 2026-10-18 下线，见下）：
 *     ① 类别   —— 单选框，只有「男寝 / 女寝」（没有「不限」）
 *     ② 楼栋   —— 下拉，选项按类别联动：选男寝只出现男寝楼栋，选女寝只出现女寝楼栋
 *     ③ 宿舍号 —— 3 位数字，第 1 位是楼层、后 2 位是房号（如 308）→ 楼层不再单独存列
 *     ④ 床位数 —— 手工填，取值 1 ~ 50；已住人数由床位实时统计，不在这里填
 *     ⑤ 状态   —— 只有「使用中 / 停用」两档
 *     ⑥ 备注   —— ≤ 50 个汉字
 *   （五条硬规则在后端 /save 里又校验了一次，前端规则能被绕过）
 *
 * 【★ 三个学段的字段差异仍由 /meta 下发，前端不写死学段判断】
 *   meta 现在只管两件事：hasCreate（能否增删改）、hasBedTable（床位是不是虚拟编号）。
 *   原来的 hasFloor / hasOwner / hasClass / hasRemark 已随列固定而下线。
 *
 * 【★ 2026-10-18 改版：筛选栏重做】
 *
 *   删掉两个控件：
 *     · 学段下拉     —— 三学段本来就合并展示，再按学段筛一次是重复信息
 *     · 只看有空床   —— 入住率筛选已能覆盖（选 0~99% 就是有空床），两个开关表达同一件事
 *
 *   筛选项顺序固定：关键字 → 类别 → 楼栋 → 状态 → 入住率
 *
 *   ① 关键字 —— **全局搜索**，匹配列表全部可见列（类别/楼栋/宿舍号/已住·床位/入住率/状态/备注）。
 *      匹配在后端服务层做（三学段合并成 DormRow 之后），取的是**显示值**不是原始列，
 *      所以搜「男寝」「停用」这种 int 码翻译出来的文字也能命中。
 *   ② 楼栋   —— **只认楼栋设置**（t_dorm_building），设置页没有的一律不出现
 *   ③ 入住率 —— 选项由 /occupancy-rates **实时**下发，不写死档位；
 *      每次 load 重拉，且跟着楼栋/类别/状态联动（后端算选项时会摘掉入住率条件本身，
 *      否则先选 50% 之后下拉就只剩 50%，用户再也选不回去）。
 *
 * 【★ 2026-10-18 改版②：新增房间弹窗去掉「学段」】
 *   列表已经合并三学段、筛选栏也不再有学段，弹窗里再让用户选一次是自相矛盾。
 *   但宿舍在后端按学段分表，saveDorm 的 stage 参数不能省 ——
 *   → 新增固定用 DEFAULT_DORM_STAGE（= job，当前实际在用的表）；
 *     编辑沿用 row.stage，绝不套用默认值（否则等于把房间搬到另一张表）。
 *
 * 【★ 2026-10-18 改版③：楼栋设置支持「类别」】
 *   楼栋字典 t_dorm_building 新增 category 列（1 男寝 / 2 女寝）。
 *   新增房间时「类别」和「楼栋」按类别联动：选男寝 → 只列男寝楼栋。
 *   老楼栋未分类（NULL）时不会出现在弹窗下拉里，需先在「系统设置 → 楼栋设置」编辑补录。
 */

import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useBreadcrumbStageKey } from '@/store/breadcrumb';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { RoleCode } from 'shared-types';
import { isReadOnlyUser, isSuperTest, myRoles } from '@/store/permission';
import { visibleStageOptions } from '@/teaching/access';
/** ★ 2026-10-20 宿舍管理的第二个子页面：班级分派 */
import DormAllocate from './DormAllocate.vue';
/** ★ 2026-10-21 第三个子页面：申请审批（接收班主任的换宿/退宿申请） */
import DormChangeApproval from './DormChangeApproval.vue';
/** ★ 2026-10-20 调宿弹窗：班级 / 学生搜索 / 楼栋床位（与班级分派同一套接口） */
import {
  listAllocateClasses,
  listAllocateBuildings,
  listAllocateRooms,
  searchAllocateStudents,
  type AllocateClassRow,
  type AllocateRoomRow,
  type AllocateStudentRow,
} from '@/teaching/api/dormAllocate';
import {
  listDormBuildings as fetchBuildingSettings,
  type DormBuildingRow,
} from '@/teaching/api/building';
import {
  listDorms,
  getDormBeds,
  getDormMeta,
  listDormBuildings,
  listDormResidents,
  listDormChanges,
  listDormOccupancyRates,
  listDormCandidates,
  saveDorm,
  deleteDorm,
  assignBed,
  checkoutBed,
  createDormChange,
  DORM_STATUS_TAG,
  DORM_CATEGORY_OPTIONS,
  DORM_CATEGORY_NAME,
  DORM_ROOM_STATUS_OPTIONS,
  DORM_ROOM_NO_RE,
  DORM_REMARK_MAX,
  DORM_BED_COUNT_MIN,
  DORM_BED_COUNT_MAX,
  DEFAULT_DORM_STAGE,
  DORM_APPROVAL_TAG,
  type DormBedRow,
  type DormChangeRow,
  type DormCandidateRow,
  type DormResidentRow,
  type DormRow,
  type DormStage,
  type DormStageMeta,
} from '@/teaching/api/dorm';

/* ---------------- 学段可见性（第 3 期：判权不再依赖旧路由） ---------------- */
/** ★ 2026-10-20 子页面页签：宿舍房间（原页面） / 班级分派（教务给各班分宿舍） */
const mainTab = ref<'rooms' | 'allocate' | 'approval'>('rooms');

/**
 * ★ 2026-10-21：班主任（且没有更高业务角色）不参与「建房间」和「班级分派」
 *
 * 业务口径：班主任在宿舍域只做「查看本班住宿 + 发起调宿/退宿申请」，
 * 房间由教务/学管统一建，班级层面的分派也归教务。
 *
 * 【为什么要排除更高角色】
 *   一个人可能同时是班主任 + 教务老师 / 校长 / 管理员（演示库就有这种复合角色）。
 *   只要他还有这些角色，就不该被当成"纯班主任"降权。
 *   SUPER_TEST（万能测试号）永远按全功能展示。
 */
const HEAD_TEACHER_SUPERIOR_ROLES: string[] = [
  RoleCode.ACAD_STAFF,
  RoleCode.RM_PRINCIPAL,
  RoleCode.SYS_ADMIN,
  RoleCode.TEACH_DEAN,
];
const isOnlyHeadTeacher = computed(() => {
  if (isSuperTest.value) return false;
  const roles = myRoles.value;
  if (!roles.includes(RoleCode.TEACH_HEAD)) return false;
  return !roles.some((r) => HEAD_TEACHER_SUPERIOR_ROLES.includes(r));
});

/**
 * ★ 2026-10-21：谁能看「申请审批」页签
 *   教务老师 / 校长 / 学管主任（审批角色）/ 系统管理员（只读可看）
 *   SUPER_TEST 测试号全功能可见；班主任看不到。
 */
const APPROVER_ROLES: string[] = [
  RoleCode.ACAD_STAFF,
  RoleCode.RM_PRINCIPAL,
  RoleCode.TEACH_DEAN,
  RoleCode.SYS_ADMIN,
];
const canApproveDorm = computed(
  () => isSuperTest.value || myRoles.value.some((r) => APPROVER_ROLES.includes(r)),
);

/** 班主任若停留在「班级分派 / 申请审批」页签，角色判定生效后强制回到「宿舍房间」 */
watch(
  [isOnlyHeadTeacher, canApproveDorm],
  () => {
    if (mainTab.value === 'allocate' && isOnlyHeadTeacher.value) mainTab.value = 'rooms';
    if (mainTab.value === 'approval' && !canApproveDorm.value) mainTab.value = 'rooms';
  },
  { immediate: true },
);

// ★ 2026-10-22 部门口径统一：对外只有「初高中 / 大学部 / 就业部」三个部门。
//   「实训」是就业部下的一个阶段（班级 dept_code=3），不是并列部门。
const STAGE_LABEL: Record<DormStage, string> = { jh: '初高', class: '大学', job: '就业部' };

const DORM_STAGE_ORDER: DormStage[] = ['jh', 'class', 'job'];
const stageOptions = computed(() => visibleStageOptions('dorm', DORM_STAGE_ORDER, STAGE_LABEL));

/* ---------------- 列表 ---------------- */
const loading = ref(false);
const rows = ref<DormRow[]>([]);
const total = ref(0);
const metaList = ref<DormStageMeta[]>([]);
const buildings = ref<Array<{ value: string; label: string }>>([]);
const residents = ref<DormResidentRow[]>([]);
const changes = ref<DormChangeRow[]>([]);
/** ★ 楼栋设置（「系统设置 → 楼栋设置」维护的那份，新增房间的楼栋下拉读它） */
const buildingSettings = ref<DormBuildingRow[]>([]);

/**
 * 新增/编辑弹窗的楼栋选项
 *
 * ★ 2026-10-18：**只认楼栋设置**，不再拿列表接口的「已在用楼栋」兜底。
 *   和筛选栏的楼栋下拉保持同一口径：设置页里没有的楼栋，就是不存在的楼栋。
 *   之前并集写法会把库里 BB-1 / A-1 这类只在房间表出现过的脏楼栋带到下拉里，
 *   用户照着它建房间，脏数据越滚越多。
 */
const buildingOptions = computed(() =>
  buildingSettings.value
    .filter((b) => {
      // 弹窗里按已选类别联动：只显示同类别楼栋；未分类楼栋两边都不显示
      if (!form.dormType) return false;
      return b.category === form.dormType;
    })
    .map((b) => String(b.buildingName ?? '').trim())
    .filter(Boolean)
    .map((v) => ({ value: v, label: v })),
);

async function loadBuildingSettings() {
  try {
    buildingSettings.value = (await fetchBuildingSettings()) || [];
  } catch {
    /* 楼栋设置拉不到就是空数组：宁可下拉空着，也不要兜底出脏楼栋 */
  }
}

const query = reactive({
  stage: undefined as DormStage | undefined,
  building: undefined as string | undefined,
  dormType: undefined as number | undefined,
  roomStatus: undefined as number | undefined,
  keyword: '',
  occupancyRate: undefined as number | undefined,
  page: 1,
  size: 20,
});

/* 面包屑第 4 级：学段筛选已下线（2026-10-18），这里恒为空，保留以便日后恢复 */
useBreadcrumbStageKey(() => query.stage || '');

/** ★ 入住率可选项：每次 load 实时重拉，跟着楼栋/类别/状态联动 */
const occupancyRates = ref<Array<{ value: number; label: string }>>([]);

/**
 * 当前所选学段的 meta（学段差异仍由后端 /meta 下发，前端不写死学段判断）
 *
 * ★ 2026-10-16：列表列已经「定死」成 类别/楼栋/宿舍号/已住-床位/入住率/状态/备注/操作，
 *   不再按 hasFloor / hasOwner / hasClass / hasRemark 动态增删列，
 *   所以下面那四个 anyHas 派生量连同它们的调用一起删了 —— 留着就是死代码。
 *   meta 现在只服务两件事：hasCreate（能不能增删改）和 hasBedTable（床位是不是虚拟编号）。
 */
const curMeta = computed(() => metaList.value.find((m) => m.stage === query.stage) || null);

/** 类别显示名：1 男寝 / 2 女寝；历史数据里的 0「不限」原样显示，不假装成别的值 */
function categoryName(row: DormRow): string {
  return DORM_CATEGORY_NAME[row.dormType] ?? row.dormTypeName ?? '不限';
}

/** ★ 只有可写学段（大学 hasCreate=false）才给新增按钮 */
const canCreate = computed(() => {
  if (isReadOnlyUser.value) return false;
  /**
   * ★ 2026-10-21：meta 没拉到（网络抖动 / 接口异常 / 首屏还没返回）时**不要隐藏按钮**。
   *   之前 `metaList` 为空 → `some()` 恒 false → 班主任偶尔看到「没有新增房间」，
   *   刷新一下又有了。写权限真正的闸在后端（40302），前端不该用空数组当"无权限"。
   */
  if (!metaList.value.length) return true;
  if (query.stage) return curMeta.value ? !!curMeta.value.hasCreate : true;
  return metaList.value.some((m) => m.hasCreate);
});
/** 行级：这一行所属学段能不能编辑 */
function canEdit(row: DormRow): boolean {
  if (isReadOnlyUser.value) return false;
  const m = metaList.value.find((x) => x.stage === row.stage);
  return !!m?.hasCreate;
}

function rateClass(row: DormRow): string {
  if (!row.bedCount) return '';
  if (row.occupancyRate >= 95) return 'ok';
  if (row.occupancyRate >= 80) return 'warn';
  return 'danger';
}

async function load(page?: number) {
  if (page) query.page = page;
  loading.value = true;
  try {
    const q = { ...query };
    const [r, m, b, rs, rates] = await Promise.all([
      listDorms(q),
      metaList.value.length ? Promise.resolve(metaList.value) : getDormMeta(),
      listDormBuildings(query.stage),
      listDormResidents(q),
      /**
       * ★ 入住率选项每次都重拉（需求：实时更新）
       *   传的 q 里带了 keyword/楼栋/类别/状态，后端会摘掉 occupancyRate 再算，
       *   所以选了「1号楼」之后，下拉只给 1号楼 真实存在的入住率。
       */
      listDormOccupancyRates(q),
    ]);
    rows.value = r.list || [];
    total.value = r.total || 0;
    metaList.value = m || [];
    buildings.value = b || [];
    residents.value = rs || [];
    occupancyRates.value = rates || [];
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function reset() {
  query.stage = undefined;
  query.building = undefined;
  query.dormType = undefined;
  query.roomStatus = undefined;
  query.keyword = '';
  query.occupancyRate = undefined;
  load(1);
}

/* ---------------- 床位抽屉 ---------------- */
const bedVisible = ref(false);
const beds = ref<DormBedRow[]>([]);
const curDorm = ref<DormRow | null>(null);

const residentsOfCur = computed(() =>
  curDorm.value ? residents.value.filter((r) => r.dormId === curDorm.value!.dormId) : [],
);

async function openBeds(row: DormRow) {
  curDorm.value = row;
  bedVisible.value = true;
  try {
    const r = await getDormBeds(row.stage, row.dormId);
    beds.value = r.beds || [];
  } catch (e) {
    ElMessage.error((e as Error).message || '加载床位失败');
    beds.value = [];
  }
}

async function doCheckout(b: DormBedRow) {
  if (!curDorm.value) return;
  try {
    await ElMessageBox.confirm(
      `确认让「${b.studentName || ''}」退宿？此操作直接生效、不走审批。`,
      '退宿确认',
      { type: 'warning' },
    );
  } catch {
    return; // 用户取消
  }
  try {
    await checkoutBed({ stage: curDorm.value.stage, dormId: curDorm.value.dormId, bedId: b.bedId });
    ElMessage.success('已退宿');
    await openBeds(curDorm.value);
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '退宿失败');
  }
}

/* ---------------- 入住 ---------------- */
const assignVisible = ref(false);
const assigning = ref(false);
const assignBedRow = ref<DormBedRow | null>(null);
const assignStudentId = ref('');
const assignDate = ref(new Date().toISOString().slice(0, 10));

/**
 * ★ 2026-10-21：入住改成「远程搜索学生」
 *
 * 旧实现是从在住名单（residents）里过滤 —— 还没入住的学生根本不在名单里，
 * 班主任分到宿舍后无法把学生填进去。
 * 新接口 `/candidates` 按数据范围下发（班主任 = 自己班、且未入住），
 * 姓名 / 学号前后模糊。
 */
const assignOptions = ref<DormCandidateRow[]>([]);
const assignLoading = ref(false);
const assignSelected = ref<DormCandidateRow | null>(null);

async function searchAssignStudents(keyword?: string) {
  const stage = curDorm.value?.stage;
  if (!stage) return;
  assignLoading.value = true;
  try {
    const list = await listDormCandidates({ stage, keyword: keyword || undefined });
    // 保留当前选中项，避免刷新候选后显示成 id
    const cur = assignSelected.value;
    assignOptions.value =
      cur && !list.some((s) => s.studentId === cur.studentId) ? [cur, ...list] : list;
  } catch {
    assignOptions.value = assignSelected.value ? [assignSelected.value] : [];
  } finally {
    assignLoading.value = false;
  }
}

function onAssignStudentChange(id: string) {
  assignSelected.value = assignOptions.value.find((s) => s.studentId === id) || null;
}

async function openAssign(b: DormBedRow) {
  assignBedRow.value = b;
  assignStudentId.value = '';
  assignSelected.value = null;
  assignOptions.value = [];
  assignDate.value = todayStr();
  assignVisible.value = true;
  await searchAssignStudents();
}

async function doAssign() {
  if (!curDorm.value || !assignBedRow.value) return;
  if (!assignStudentId.value) {
    ElMessage.warning('请先选择学生');
    return;
  }
  assigning.value = true;
  try {
    await assignBed({
      stage: curDorm.value.stage,
      dormId: curDorm.value.dormId,
      bedId: assignBedRow.value.bedId,
      studentId: assignStudentId.value,
      checkInDate: assignDate.value,
    });
    ElMessage.success('入住成功');
    assignVisible.value = false;
    await openBeds(curDorm.value);
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '入住失败');
  } finally {
    assigning.value = false;
  }
}

/* ---------------- 新增 / 编辑 ---------------- */
const editVisible = ref(false);
const saving = ref(false);
const formRef = ref<FormInstance>();
const form = reactive<Record<string, any>>({
  id: undefined as string | undefined,
  /**
   * ★ 学段不再出现在弹窗里（用户不需要也不该知道三学段的分表），但**接口参数里还得有**：
   *   宿舍在三学段是分表存的，保存时后端靠 stage 决定写哪张表。
   *   → 新增固定写 DEFAULT_DORM_STAGE；编辑时沿用房间自己的 stage，别把房间搬到别的表去。
   */
  stage: DEFAULT_DORM_STAGE,
  buildingName: '',
  roomNo: '',
  dormType: 1,
  bedCount: 4,
  roomStatus: 1,
  remark: '',
});

/** ★ 宿舍号第 1 位 = 楼层（输入时实时提示，楼层不再单独存一列） */
const roomNoFloor = computed(() =>
  DORM_ROOM_NO_RE.test(form.roomNo) ? Number(form.roomNo.slice(0, 1)) : 0,
);

const rules: FormRules = {
  buildingName: [{ required: true, message: '请选择楼栋', trigger: 'change' }],
  dormType: [{ required: true, message: '请选择类别', trigger: 'change' }],
  bedCount: [
    {
      validator: (_r: unknown, v: number, cb: (e?: Error) => void) => {
        const n = Number(v);
        if (!Number.isInteger(n)) return cb(new Error('床位数必须是整数'));
        if (n < DORM_BED_COUNT_MIN || n > DORM_BED_COUNT_MAX) {
          return cb(new Error(`床位数取值范围 ${DORM_BED_COUNT_MIN} ~ ${DORM_BED_COUNT_MAX}`));
        }
        return cb();
      },
      trigger: 'change',
    },
  ],
  roomNo: [
    { required: true, message: '宿舍号必填', trigger: 'blur' },
    {
      validator: (_r: unknown, v: string, cb: (e?: Error) => void) => {
        if (!v) return cb();
        if (!DORM_ROOM_NO_RE.test(String(v))) {
          return cb(new Error('宿舍号必须是 3 位数字（第 1 位楼层 + 后 2 位房号，如 308）'));
        }
        return cb();
      },
      trigger: 'blur',
    },
  ],
  remark: [
    {
      validator: (_r: unknown, v: string, cb: (e?: Error) => void) => {
        if (v && [...String(v)].length > DORM_REMARK_MAX) {
          return cb(new Error(`备注不能超过 ${DORM_REMARK_MAX} 个汉字`));
        }
        return cb();
      },
      trigger: 'blur',
    },
  ],
};

/**
 * ★ 类别切换时，若当前楼栋不在新类别对应的选项里，自动清空楼栋
 *   避免「类别=男寝、楼栋=女寝楼」这种无效组合存进库。
 */
watch(
  () => form.dormType,
  () => {
    const ok = buildingOptions.value.some((b) => b.value === form.buildingName);
    if (!ok) form.buildingName = '';
  },
);

function openCreate() {
  Object.assign(form, {
    id: undefined,
    stage: DEFAULT_DORM_STAGE,
    buildingName: '',
    roomNo: '',
    dormType: 1,
    bedCount: 4,
    roomStatus: 1,
    remark: '',
  });
  // ★ 每次开弹窗都重拉一次楼栋设置：设置页刚加的楼栋，这边立刻能选到
  loadBuildingSettings();
  editVisible.value = true;
}

function openEdit(row: DormRow) {
  Object.assign(form, {
    id: row.dormId,
    stage: row.stage,
    buildingName: row.buildingName,
    roomNo: row.roomNo,
    /**
     * ★ 历史数据的 dormType 可能是 0「不限」，但新增/编辑口径已收紧成二选一，
     *   编辑时给个默认值 1（男寝），否则单选框两个都不亮、用户不知道自己选没选。
     */
    dormType: row.dormType === 2 ? 2 : 1,
    bedCount: row.bedCount,
    roomStatus: row.roomStatus === 4 ? 4 : 1,
    remark: row.remark || '',
  });
  loadBuildingSettings();
  editVisible.value = true;
}

async function doSave() {
  const okd = await formRef.value?.validate().catch(() => false);
  if (!okd) return;
  saving.value = true;
  try {
    /**
     * ★ 备注一律送字符串（没填就送空串）——老逻辑里「没填」被当成「不修改」，
     *   于是用户在编辑框里把备注删空、保存后备注还在。备注现在是常规字段，
     *   清空的意图就该生效。
     */
    const payload: Record<string, unknown> = {
      stage: form.stage,
      id: form.id,
      buildingName: form.buildingName,
      roomNo: form.roomNo,
      bedCount: form.bedCount,
      dormType: form.dormType,
      roomStatus: form.roomStatus,
      remark: form.remark || '',
    };
    await saveDorm(payload);
    ElMessage.success(form.id ? '房间已更新' : '房间已创建');
    editVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function doDelete(row: DormRow) {
  /**
   * ★ 前端先挡一次：有学生住着就不能删
   *   后端 repo.remove() 会同时查「学生主档 dorm_id」和「床位占用」再拦一次，
   *   这里是前端的前置提示，省得用户走完确认框才吃到报错。
   */
  if (row.occupiedCount > 0) {
    ElMessage.warning('该宿舍还有学生入住，不能删除；请先办理退宿');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确认删除房间「${row.roomNo}」？删除后「楼栋设置」里该楼栋的宿舍数会相应减少。`,
      '删除确认',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await deleteDorm(row.stage, row.dormId);
    ElMessage.success('已删除');
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '删除失败');
  }
}

/* ---------------- 调宿 / 退宿申请 ---------------- */
const changeVisible = ref(false);
const changeListVisible = ref(false);
const changeLoading = ref(false);
const changeSaving = ref(false);

/** 班级下拉（来自班级管理已建班级） */
const changeClasses = ref<AllocateClassRow[]>([]);
/** 学生搜索结果（姓名 / 学号前后模糊） */
const changeStudents = ref<AllocateStudentRow[]>([]);
const studentLoading = ref(false);
/** 当前选中的学生（用于回显当前宿舍） */
const curStudent = ref<AllocateStudentRow | null>(null);

/** 目标宿舍：楼栋 → 房间（含空闲床位明细） */
const changeBuildings = ref<string[]>([]);
const changeRooms = ref<AllocateRoomRow[]>([]);
const changeRoomsLoading = ref(false);
/** 只保留还有空床位的房间，下拉里按房间分组列床位 */
const changeRoomsWithBeds = computed(() => changeRooms.value.filter((r) => r.freeBeds.length > 0));

/** 本地当天日期（不用 toISOString —— 那是 UTC，早上 8 点前会变成昨天） */
function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const changeForm = reactive({
  bizType: 1,
  className: '',
  studentId: '',
  category: 1,
  building: '',
  targetBedId: '',
  changeDate: todayStr(),
  changeReason: '',
});

function resetChangeForm() {
  Object.assign(changeForm, {
    bizType: 1,
    className: '',
    studentId: '',
    category: 1,
    building: '',
    targetBedId: '',
    changeDate: todayStr(),
    changeReason: '',
  });
  curStudent.value = null;
  changeStudents.value = [];
  changeBuildings.value = [];
  changeRooms.value = [];
}

/** 打开发起申请弹窗 */
async function openChange() {
  resetChangeForm();
  changeVisible.value = true;
  /**
   * ★ 2026-10-20 修复：弹窗一打开就要把默认类别（男寝）的楼栋拉出来。
   *   之前只在「切换类别 / 选学生」时才拉，导致刚打开时楼栋下拉是空的，
   *   用户以为「无数据」，目标床位也跟着没得选。
   */
  void onChangeCategory();
  try {
    changeClasses.value = (await listAllocateClasses()) || [];
  } catch (e) {
    ElMessage.error((e as Error).message || '加载班级失败');
    changeClasses.value = [];
  }
}

/** 班级变化 → 清空学生 / 目标床位，并按班级重搜学生 */
async function onChangeClass() {
  changeForm.studentId = '';
  curStudent.value = null;
  changeForm.targetBedId = '';
  await searchChangeStudents('');
}

/** 学生搜索（远程）：空关键字 = 列出该班全部学生 */
async function searchChangeStudents(keyword: string) {
  studentLoading.value = true;
  try {
    const list = await searchAllocateStudents({
      className: changeForm.className || undefined,
      keyword: keyword || undefined,
    });
    // 保留当前已选学生，避免刷新候选后 el-select 把选中项显示成 id
    const cur = curStudent.value;
    changeStudents.value =
      cur && !list.some((s) => s.studentId === cur.studentId) ? [cur, ...list] : list;
  } catch {
    changeStudents.value = curStudent.value ? [curStudent.value] : [];
  } finally {
    studentLoading.value = false;
  }
}

/** 选学生 → 回显当前宿舍，并按性别预选目标类别 */
async function onChangeStudent(studentId: string) {
  const s = changeStudents.value.find((x) => x.studentId === studentId) || null;
  curStudent.value = s;
  changeForm.targetBedId = '';
  if (s) {
    changeForm.category = s.gender === 2 ? 2 : 1;
    await onChangeCategory();
  }
}

/** 切换类型：调宿时按学生性别预选类别；退宿不需要目标宿舍 */
async function onChangeBizType() {
  changeForm.targetBedId = '';
  if (changeForm.bizType === 1) {
    if (curStudent.value) {
      changeForm.category = curStudent.value.gender === 2 ? 2 : 1;
    }
    // 没选学生时也要保证当前类别的楼栋已经加载出来
    await onChangeCategory();
  }
}

/** 类别变化 → 重拉该类别楼栋，清空楼栋 / 床位 */
async function onChangeCategory() {
  changeForm.building = '';
  changeForm.targetBedId = '';
  changeRooms.value = [];
  try {
    changeBuildings.value = (await listAllocateBuildings(changeForm.category)) || [];
  } catch {
    changeBuildings.value = [];
  }
}

/** 楼栋变化 → 拉该楼栋的房间与空床位 */
async function loadChangeRooms() {
  changeForm.targetBedId = '';
  if (!changeForm.building) {
    changeRooms.value = [];
    return;
  }
  changeRoomsLoading.value = true;
  try {
    changeRooms.value = (await listAllocateRooms(changeForm.category, changeForm.building)) || [];
  } catch (e) {
    ElMessage.error((e as Error).message || '加载宿舍失败');
    changeRooms.value = [];
  } finally {
    changeRoomsLoading.value = false;
  }
}

async function doCreateChange() {
  if (!changeForm.className) {
    ElMessage.warning('请选择班级');
    return;
  }
  if (!changeForm.studentId || !curStudent.value) {
    ElMessage.warning('请选择学生');
    return;
  }
  const reason = changeForm.changeReason.trim();
  if (!reason) {
    ElMessage.warning('请填写原因');
    return;
  }
  if ([...reason].length > 100) {
    ElMessage.warning('原因不能超过 100 个字符');
    return;
  }

  let targetRoom: AllocateRoomRow | undefined;
  if (changeForm.bizType === 1) {
    if (!changeForm.building) {
      ElMessage.warning('请选择楼栋');
      return;
    }
    if (!changeForm.targetBedId) {
      ElMessage.warning('请选择目标床位');
      return;
    }
    targetRoom = changeRooms.value.find((r) =>
      r.freeBeds.some((b) => b.bedId === changeForm.targetBedId),
    );
    if (!targetRoom) {
      ElMessage.warning('目标床位不存在或已被占用，请重新选择');
      return;
    }
  }

  changeSaving.value = true;
  try {
    /**
     * ★ 学段下拉已去掉（三学段合并展示）。落库学段取当前账号**可见的第一个宿舍学段**
     *   （教务老师 = 初高）；三学段共用同一批宿舍表，弹窗里的楼栋/床位都来自它。
     *   后端 changeCreate 还留了一层兜底：请求学段没权限时退回可见学段。
     */
    const stage = ((stageOptions.value[0]?.value as DormStage) || 'job') as DormStage;
    await createDormChange({
      stage,
      bizType: changeForm.bizType,
      studentId: changeForm.studentId,
      oldDormId: curStudent.value.dormId || undefined,
      // ★ 2026-10-21：旧床位必须带上 —— 审批通过时要靠它释放原床位（退宿尤其重要）
      oldBedId: curStudent.value.bedId || undefined,
      newDormId: targetRoom?.roomId,
      newBedId: changeForm.targetBedId || undefined,
      changeDate: changeForm.changeDate,
      changeReason: reason,
    });
    ElMessage.success('申请已提交，等待审批');
    changeVisible.value = false;
  } catch (e) {
    ElMessage.error((e as Error).message || '提交失败');
  } finally {
    changeSaving.value = false;
  }
}

async function openChangeList() {
  changeListVisible.value = true;
  changeLoading.value = true;
  try {
    changes.value = (await listDormChanges({ stage: query.stage })) || [];
  } catch (e) {
    ElMessage.error((e as Error).message || '加载申请失败');
  } finally {
    changeLoading.value = false;
  }
}

// 「调宿/退宿申请」按钮先出申请弹窗，列表入口挂在下面的提示区
function openChangeEntry() {
  openChange();
}

onMounted(async () => {
  await load(1);
  await loadBuildingSettings();
  // 预取一次 meta，让按钮显隐在首屏就正确
  if (!metaList.value.length) {
    try {
      metaList.value = (await getDormMeta()) || [];
    } catch {
      /* 忽略：load 里已经报过了 */
    }
  }
});

// 供模板里「查看申请列表」使用
defineExpose({ openChangeList, openChangeEntry });

</script>

<style scoped>
.tdv-tip { margin-bottom: 12px; }
.tdv-tip :deep(.muted) { color: #A2938E; font-weight: normal; }

.tdv-filter { margin-bottom: 8px; }

/** 表单项下方的灰色说明（楼栋来源 / 宿舍号规则） */
.tdv-hint { color: #A2938E; font-size: 12px; line-height: 1.5; margin-top: 2px; }

.link { color: #CD3A33; cursor: pointer; text-decoration: none; }
.link:hover { text-decoration: underline; }
.ok { color: #5FA36F; }
.warn { color: #C9852E; }
.danger { color: #CD3A33; }
.muted { color: #A2938E; font-size: 12px; }
/* ★ 2026-10-20 调宿弹窗：只读日期 / 行内说明间距 */
.tdv-date { font-weight: 600; color: #443432; }
.ml12 { margin-left: 12px; }
/* 当前宿舍：楼栋 / 宿舍号 / 床位号 三项并排 */
.cur-dorm { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; color: #443432; }
.cur-dorm b { color: #B22A23; font-weight: 600; }

.tdv-page { margin-top: 12px; justify-content: flex-end; }

.tdv-bed-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

.tdv-beds {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 10px;
}
.tdv-bed {
  border: 1px solid #E2D7D1;
  border-radius: 6px;
  padding: 8px 10px;
  background: #FAF7F4;
}
.tdv-bed.is-free { border-color: #F9E4E1; background: #FDF4F2; }
.tdv-bed.is-used { border-color: #D9EDE0; background: #EBF5EF; }
.tdv-bed__no { font-weight: 600; margin-bottom: 4px; }
.tdv-bed__who { font-size: 12px; min-height: 18px; display: flex; gap: 6px; align-items: baseline; }
.tdv-bed__ops { margin-top: 4px; }

.tdv-change-tip { margin-top: 12px; }
</style>
