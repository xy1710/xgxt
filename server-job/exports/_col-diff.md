# 老表 → 统一表 列对账（自动生成，共 76 对）


## sms_class_jh.t_class_info → t_uni_class   (老21列 / 统一33列)
  仅老表有(0): —
  仅统一有(12): edu_stage, stage_code, room, attendance_rate, project_manager_id, project_manager_name, employment_teacher_id, employment_teacher_name, university_no, class_code, close_date, prev_class_status
  共有(21): id, create_time, create_by, update_time, update_by, is_deleted, class_name, stage, head_teacher_id, head_teacher_name, teacher_id, teacher_name, assistant_id, assistant_name, classroom, open_date, dept_code, class_status, student_count, today_attendance_rate, remark

## sms_class.t_class_info → t_uni_class   (老25列 / 统一33列)
  仅老表有(0): —
  仅统一有(8): edu_stage, stage_code, classroom, today_attendance_rate, remark, class_code, close_date, prev_class_status
  共有(25): id, create_time, create_by, update_time, update_by, is_deleted, class_name, dept_code, stage, head_teacher_id, head_teacher_name, teacher_id, teacher_name, assistant_id, assistant_name, room, open_date, student_count, class_status, attendance_rate, project_manager_id, project_manager_name, employment_teacher_id, employment_teacher_name, university_no

## sms_job.t_job_class → t_uni_class   (老29列 / 统一33列)
  仅老表有(0): —
  仅统一有(4): edu_stage, stage_code, today_attendance_rate, room
  共有(29): id, create_time, create_by, update_time, update_by, is_deleted, class_name, class_code, dept_code, stage, head_teacher_id, head_teacher_name, teacher_id, teacher_name, assistant_id, assistant_name, classroom, open_date, close_date, student_count, class_status, attendance_rate, remark, prev_class_status, project_manager_id, project_manager_name, employment_teacher_id, employment_teacher_name, university_no

## sms_class_jh.t_class_student → t_uni_student   (老49列 / 统一73列)
  仅老表有(0): —
  仅统一有(24): edu_stage, stage_code, source_update_time, sync_status, id_card, origin, recruit_teacher_id, recruit_phone, consult_teacher_id, consult_phone, quality_study, quality_discipline, quality_ability, quality_comprehension, quality_expression, quality_social, quality_note, source_batch_no, dorm_building, admission_teacher, admission_teacher_phone, consult_teacher, resume_name, resume_data
  共有(49): id, create_time, create_by, update_time, update_by, is_deleted, student_no, student_name, gender, birth_date, age, native_place, dept_code, class_id, class_name, stage, head_teacher_id, head_teacher_name, teacher_id, teacher_name, assistant_id, assistant_name, student_status, pending_flow_type, education, graduate_school, enroll_date, phone, parent_phone, home_address, id_card_no, agreement_status, id_photo_url, household_photo_url, net_account, net_init_password, recruit_teacher_name, recruit_teacher_phone, consult_teacher_name, consult_teacher_phone, dorm_id, dorm_no, bed_no, attendance_rate, repeat_count, remark, literacy_desc, source_system, source_id

## sms_class.t_class_student → t_uni_student   (老57列 / 统一73列)
  仅老表有(0): —
  仅统一有(16): edu_stage, stage_code, native_place, pending_flow_type, id_card_no, agreement_status, net_account, net_init_password, recruit_teacher_phone, consult_teacher_phone, literacy_desc, admission_teacher, admission_teacher_phone, consult_teacher, resume_name, resume_data
  共有(57): id, create_time, create_by, update_time, update_by, is_deleted, source_system, source_id, source_update_time, sync_status, student_no, student_name, gender, age, dept_code, student_status, stage, id_card, phone, parent_phone, education, enroll_date, repeat_count, attendance_rate, remark, class_id, class_name, head_teacher_id, head_teacher_name, teacher_id, teacher_name, assistant_id, assistant_name, dorm_id, dorm_no, birth_date, origin, graduate_school, home_address, id_photo_url, household_photo_url, recruit_teacher_id, recruit_teacher_name, recruit_phone, consult_teacher_id, consult_teacher_name, consult_phone, quality_study, quality_discipline, quality_ability, quality_comprehension, quality_expression, quality_social, quality_note, source_batch_no, bed_no, dorm_building

## sms_job.t_student_base → t_uni_student   (老41列 / 统一73列)
  仅老表有(0): —
  仅统一有(32): edu_stage, stage_code, pending_flow_type, id_card_no, agreement_status, id_photo_url, household_photo_url, net_account, net_init_password, recruit_teacher_name, recruit_teacher_phone, consult_teacher_name, bed_no, literacy_desc, source_system, source_id, source_update_time, sync_status, origin, recruit_teacher_id, recruit_phone, consult_teacher_id, consult_phone, quality_study, quality_discipline, quality_ability, quality_comprehension, quality_expression, quality_social, quality_note, source_batch_no, dorm_building
  共有(41): id, create_time, create_by, update_time, update_by, is_deleted, student_no, student_name, gender, age, dept_code, class_id, class_name, head_teacher_id, head_teacher_name, teacher_id, teacher_name, assistant_id, assistant_name, student_status, stage, phone, parent_phone, dorm_id, dorm_no, education, enroll_date, attendance_rate, repeat_count, remark, birth_date, native_place, graduate_school, home_address, admission_teacher, admission_teacher_phone, consult_teacher, consult_teacher_phone, resume_name, resume_data, id_card

## sms_job.t_job_class_student → t_uni_class_student   (老19列 / 统一21列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(19): id, create_time, create_by, update_time, update_by, is_deleted, class_id, class_name, student_id, student_no, student_name, join_date, join_type, leave_date, leave_type, leave_reason, status, remark, uk_in_class

## sms_class_jh.t_class_attendance → t_uni_attendance   (老19列 / 统一32列)
  仅老表有(0): —
  仅统一有(13): edu_stage, stage_code, present_count, absent_count, student_id, student_no, student_name, attend_date, attend_status, attend_type, reason, registrar_id, registrar_name
  共有(19): id, create_time, create_by, update_time, update_by, is_deleted, class_id, class_name, attendance_date, attendance_rate, should_count, actual_count, month_unqualified_count, teacher_id, teacher_name, head_teacher_id, head_teacher_name, file_url, remark

## sms_class.t_class_attendance → t_uni_attendance   (老15列 / 统一32列)
  仅老表有(0): —
  仅统一有(17): edu_stage, stage_code, actual_count, month_unqualified_count, teacher_id, head_teacher_id, file_url, remark, student_id, student_no, student_name, attend_date, attend_status, attend_type, reason, registrar_id, registrar_name
  共有(15): id, create_time, create_by, update_time, update_by, is_deleted, class_id, class_name, attendance_date, should_count, present_count, absent_count, attendance_rate, teacher_name, head_teacher_name

## sms_class_jh.t_class_exam → t_uni_exam   (老18列 / 统一27列)
  仅老表有(0): —
  仅统一有(9): edu_stage, stage_code, creator_id, creator_name, attendee_count, exam_time, class_ids, class_names, content_types
  共有(18): id, create_time, create_by, update_time, update_by, is_deleted, exam_name, exam_type, exam_date, class_id, class_name, exam_content_types, content_full_score, exam_status, score_teacher_ids, judge_ids, create_by_name, remark

## sms_class.t_class_exam → t_uni_exam   (老14列 / 统一27列)
  仅老表有(0): —
  仅统一有(13): edu_stage, stage_code, exam_content_types, content_full_score, exam_status, score_teacher_ids, judge_ids, create_by_name, remark, exam_time, class_ids, class_names, content_types
  共有(14): id, create_time, create_by, update_time, update_by, is_deleted, exam_name, exam_type, creator_id, creator_name, exam_date, class_id, class_name, attendee_count

## sms_job.t_job_exam → t_uni_exam   (老15列 / 统一27列)
  仅老表有(0): —
  仅统一有(12): edu_stage, stage_code, exam_date, class_id, class_name, exam_content_types, content_full_score, exam_status, score_teacher_ids, judge_ids, create_by_name, attendee_count
  共有(15): id, create_time, create_by, update_time, update_by, is_deleted, exam_name, exam_type, exam_time, class_ids, class_names, content_types, creator_id, creator_name, remark

## sms_class_jh.t_class_exam_field → t_uni_exam_field   (老10列 / 统一16列)
  仅老表有(0): —
  仅统一有(6): edu_stage, stage_code, field_key, default_value, source, field_type_text
  共有(10): id, create_time, create_by, update_time, update_by, is_deleted, exam_id, field_name, field_type, sort_no

## sms_class.t_class_exam_field → t_uni_exam_field   (老10列 / 统一16列)
  仅老表有(0): —
  仅统一有(6): edu_stage, stage_code, exam_id, field_name, sort_no, field_type_text
  共有(10): id, create_time, create_by, update_time, update_by, is_deleted, field_key, field_type, default_value, source

## sms_class.t_class_exam_content → t_uni_exam_content   (老10列 / 统一12列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(10): id, create_time, create_by, update_time, update_by, is_deleted, exam_id, exam_content_type, full_score, content_name

## sms_class_jh.t_class_repeat → t_uni_repeat   (老20列 / 统一26列)
  仅老表有(0): —
  仅统一有(6): edu_stage, stage_code, exam_name, written_score, interview_score, comp_score
  共有(20): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, from_class_id, from_class_name, from_stage, to_class_id, to_class_name, to_stage, repeat_reason, repeat_time, repeat_count, notify_user_id, is_notified

## sms_class.t_class_repeat → t_uni_repeat   (老20列 / 统一26列)
  仅老表有(0): —
  仅统一有(6): edu_stage, stage_code, from_stage, to_stage, notify_user_id, is_notified
  共有(20): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, repeat_time, repeat_reason, from_class_id, from_class_name, to_class_id, to_class_name, repeat_count, exam_name, written_score, interview_score, comp_score

## sms_class_jh.t_class_dorm_apply → t_uni_dorm_apply   (老27列 / 统一60列)
  仅老表有(0): —
  仅统一有(33): edu_stage, stage_code, apply_no, apply_category, from_dorm_id, from_dorm_no, to_dorm_id, to_dorm_no, has_goods_checked, applicant_id, applicant_name, approver_id, approver_name, biz_type, gender, phone, dept_code, head_teacher_id, head_teacher_name, old_dorm_id, old_dorm_no, old_bed_id, old_bed_no, new_dorm_id, new_dorm_no, new_bed_id, new_bed_no, change_date, change_reason, head_teacher_opinion, approval_id, approval_status, remark
  共有(27): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, class_id, class_name, from_room_id, from_room_no, from_bed_id, to_room_id, to_room_no, to_bed_id, apply_reason, apply_user_id, apply_user_name, apply_time, apply_status, approve_user_id, approve_user_name, approve_time, is_item_intact, reject_reason

## sms_class.t_class_dorm_apply → t_uni_dorm_apply   (老27列 / 统一60列)
  仅老表有(0): —
  仅统一有(33): edu_stage, stage_code, from_room_id, from_room_no, from_bed_id, to_room_id, to_room_no, to_bed_id, apply_user_id, apply_user_name, approve_user_id, approve_user_name, is_item_intact, biz_type, gender, phone, dept_code, head_teacher_id, head_teacher_name, old_dorm_id, old_dorm_no, old_bed_id, old_bed_no, new_dorm_id, new_dorm_no, new_bed_id, new_bed_no, change_date, change_reason, head_teacher_opinion, approval_id, approval_status, remark
  共有(27): id, create_time, create_by, update_time, update_by, is_deleted, apply_no, apply_category, student_id, student_no, student_name, class_id, class_name, from_dorm_id, from_dorm_no, to_dorm_id, to_dorm_no, apply_reason, apply_status, reject_reason, has_goods_checked, applicant_id, applicant_name, apply_time, approver_id, approver_name, approve_time

## sms_job.t_job_dorm → t_uni_dorm_room   (老16列 / 统一36列)
  仅老表有(0): —
  仅统一有(20): edu_stage, stage_code, building_id, building_name, floor_no, dorm_type, occupied_count, occupancy_rate, owner_name, data_source, room_status, class_id, class_name, source_system, source_id, source_batch_no, source_update_time, sync_status, leader_student_id, leader_student_name
  共有(16): id, create_time, create_by, update_time, update_by, is_deleted, dorm_no, building, room_no, bed_count, used_count, dorm_gender, dept_code, dorm_status, facility, remark

## sms_class_jh.t_class_room → t_uni_dorm_room   (老19列 / 统一36列)
  仅老表有(0): —
  仅统一有(17): edu_stage, stage_code, dorm_no, building, used_count, dorm_gender, dept_code, dorm_status, facility, remark, source_system, source_id, source_batch_no, source_update_time, sync_status, leader_student_id, leader_student_name
  共有(19): id, create_time, create_by, update_time, update_by, is_deleted, building_id, building_name, floor_no, room_no, dorm_type, bed_count, occupied_count, occupancy_rate, owner_name, data_source, room_status, class_id, class_name

## sms_common.t_class_dorm_room_sync → t_uni_dorm_room   (老19列 / 统一36列)
  仅老表有(0): —
  仅统一有(17): edu_stage, stage_code, floor_no, room_no, occupied_count, occupancy_rate, owner_name, data_source, room_status, class_id, class_name, building, dorm_gender, dept_code, dorm_status, facility, remark
  共有(19): id, create_time, create_by, update_time, update_by, is_deleted, source_system, source_id, source_batch_no, source_update_time, sync_status, building_id, building_name, dorm_type, dorm_no, bed_count, used_count, leader_student_id, leader_student_name

## sms_job.t_job_dorm_bed → t_uni_dorm_bed   (老16列 / 统一22列)
  仅老表有(0): —
  仅统一有(6): edu_stage, stage_code, room_id, room_no, building_id, dorm_type
  共有(16): id, create_time, create_by, update_time, update_by, is_deleted, dorm_id, dorm_no, bed_status, student_id, student_no, student_name, student_gender, check_in_date, remark, bed_no

## sms_class_jh.t_class_bed → t_uni_dorm_bed   (老13列 / 统一22列)
  仅老表有(0): —
  仅统一有(9): edu_stage, stage_code, dorm_id, dorm_no, student_no, student_name, student_gender, check_in_date, remark
  共有(13): id, create_time, create_by, update_time, update_by, is_deleted, room_id, room_no, building_id, bed_no, dorm_type, bed_status, student_id

## sms_class_jh.t_class_dorm_resident → t_uni_dorm_resident   (老20列 / 统一27列)
  仅老表有(0): —
  仅统一有(7): edu_stage, stage_code, source_system, source_id, source_batch_no, source_update_time, sync_status
  共有(20): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, class_id, class_name, gender, building_id, room_id, room_no, bed_id, bed_no, check_in_date, owner_name, is_active

## sms_common.t_class_dorm_live_sync → t_uni_dorm_resident   (老19列 / 统一27列)
  仅老表有(2): dorm_id, dorm_no
  仅统一有(10): edu_stage, stage_code, gender, building_id, room_id, room_no, bed_id, bed_no, owner_name, is_active
  共有(17): id, create_time, create_by, update_time, update_by, is_deleted, source_system, source_id, source_batch_no, source_update_time, sync_status, student_id, student_no, student_name, class_id, class_name, check_in_date

## sms_job.t_dorm → t_uni_dorm_building   (老12列 / 统一22列)
  仅老表有(0): —
  仅统一有(10): edu_stage, stage_code, building_name, campus_name, floor_count, manager_name, manager_phone, dept_name, building_status, data_source
  共有(12): id, create_time, create_by, update_time, update_by, is_deleted, dorm_no, building, floor, room_type, bed_total, remark

## sms_job.t_job_dorm_change → t_uni_dorm_change   (老31列 / 统一33列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(31): id, create_time, create_by, update_time, update_by, is_deleted, biz_type, student_id, student_no, student_name, gender, phone, class_id, class_name, dept_code, head_teacher_id, head_teacher_name, old_dorm_id, old_dorm_no, old_bed_id, old_bed_no, new_dorm_id, new_dorm_no, new_bed_id, new_bed_no, change_date, change_reason, head_teacher_opinion, approval_id, approval_status, remark

## sms_class.t_class_dorm_change_log → t_uni_dorm_change_log   (老15列 / 统一17列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(15): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, from_dorm_id, from_dorm_no, to_dorm_id, to_dorm_no, change_time, change_reason

## sms_class.t_class_suspend_apply → t_uni_approval   (老34列 / 统一87列)
  仅老表有(0): —
  仅统一有(53): edu_stage, stage_code, flow_type, apply_user_id, apply_user_name, flow_status, current_node_name, approve_user_id, approve_user_name, approve_time, suspend_status, suspend_start_date, suspend_reason, id_card_no, phone, attended_hours, resume_class_id, resume_date, is_meal_dorm_restored, from_class_id, to_class_id, from_stage, to_stage, transfer_reason, handover_role, from_user_id, to_user_id, handover_reason, handover_content, handover_time, arrange_user_id, agreement_status, sign_date, agreement_file_url, refund_fee_type, refund_amount, notify_user_id, is_notified, biz_type, gender, address, dept_name, head_teacher_id, head_teacher_name, leave_date, leave_reason, head_teacher_opinion, approval_id, approval_status, related_refund_no, remark, new_class_id, new_class_name
  共有(34): id, create_time, create_by, update_time, update_by, is_deleted, apply_no, apply_type, student_id, student_no, student_name, class_id, class_name, dept_code, id_card, parent_phone, apply_reason, effect_date, expect_resume_date, occurred_amount, refundable_amount, apply_status, applicant_id, applicant_name, apply_time, manager_approver_id, manager_approver_name, manager_approve_time, manager_opinion, principal_approver_id, principal_approver_name, principal_approve_time, principal_opinion, reject_reason

## sms_class_jh.t_class_flow → t_uni_approval   (老51列 / 统一87列)
  仅老表有(0): —
  仅统一有(36): edu_stage, stage_code, apply_no, apply_type, dept_code, id_card, parent_phone, effect_date, occurred_amount, refundable_amount, apply_status, applicant_id, applicant_name, manager_approver_id, manager_approver_name, manager_approve_time, manager_opinion, principal_approver_id, principal_approver_name, principal_approve_time, principal_opinion, biz_type, gender, address, dept_name, head_teacher_id, head_teacher_name, leave_date, leave_reason, head_teacher_opinion, approval_id, approval_status, related_refund_no, remark, new_class_id, new_class_name
  共有(51): id, create_time, create_by, update_time, update_by, is_deleted, flow_type, student_id, student_no, student_name, class_id, class_name, apply_user_id, apply_user_name, apply_time, apply_reason, flow_status, current_node_name, approve_user_id, approve_user_name, approve_time, reject_reason, suspend_status, suspend_start_date, expect_resume_date, suspend_reason, id_card_no, phone, attended_hours, resume_class_id, resume_date, is_meal_dorm_restored, from_class_id, to_class_id, from_stage, to_stage, transfer_reason, handover_role, from_user_id, to_user_id, handover_reason, handover_content, handover_time, arrange_user_id, agreement_status, sign_date, agreement_file_url, refund_fee_type, refund_amount, notify_user_id, is_notified

## sms_job.t_job_student_leave → t_uni_approval   (老31列 / 统一87列)
  仅老表有(0): —
  仅统一有(56): edu_stage, stage_code, flow_type, apply_user_id, apply_user_name, apply_time, apply_reason, flow_status, current_node_name, approve_user_id, approve_user_name, approve_time, reject_reason, suspend_status, suspend_start_date, expect_resume_date, suspend_reason, id_card_no, resume_class_id, resume_date, is_meal_dorm_restored, from_class_id, to_class_id, from_stage, to_stage, transfer_reason, handover_role, from_user_id, to_user_id, handover_reason, handover_content, handover_time, arrange_user_id, agreement_status, sign_date, agreement_file_url, refund_fee_type, refund_amount, notify_user_id, is_notified, apply_no, apply_type, effect_date, occurred_amount, refundable_amount, apply_status, applicant_id, applicant_name, manager_approver_id, manager_approver_name, manager_approve_time, manager_opinion, principal_approver_id, principal_approver_name, principal_approve_time, principal_opinion
  共有(31): id, create_time, create_by, update_time, update_by, is_deleted, biz_type, student_id, student_no, student_name, gender, id_card, phone, parent_phone, address, class_id, class_name, dept_name, dept_code, head_teacher_id, head_teacher_name, attended_hours, leave_date, leave_reason, head_teacher_opinion, approval_id, approval_status, related_refund_no, remark, new_class_id, new_class_name

## sms_class.t_class_approval_log → t_uni_approval_log   (老17列 / 统一32列)
  仅老表有(0): —
  仅统一有(15): edu_stage, stage_code, flow_id, node_name, approve_user_id, approve_user_name, approve_time, approve_result, reject_reason, remark, approval_id, biz_type, step, action_name, comment
  共有(17): id, create_time, create_by, update_time, update_by, is_deleted, apply_type, apply_no, biz_id, action, from_status, to_status, operator_id, operator_name, operator_role, opinion, operate_time

## sms_class_jh.t_class_approval_log → t_uni_approval_log
  ⚠️ 老表不存在或 0 列

## sms_class.t_class_refund_apply → t_uni_refund   (老22列 / 统一50列)
  仅老表有(0): —
  仅统一有(28): edu_stage, stage_code, fee_type, head_teacher_opinion, apply_date, is_fee_used_up, current_handler_name, apply_user_id, apply_user_name, approve_user_id, approve_user_name, approve_time, threshold_amount, pay_out_time, pay_out_voucher_no, dept_name, head_teacher_id, head_teacher_name, refund_type, refund_type_name, approval_id, approval_status, finance_remark, refund_time, remark, tuition_amount, accommodation_amount, meal_amount
  共有(22): id, create_time, create_by, update_time, update_by, is_deleted, apply_no, student_id, student_no, student_name, class_id, class_name, dept_code, refund_amount, refund_reason, refund_status, is_need_principal, applicant_id, applicant_name, apply_time, current_handler_role, reject_reason

## sms_class.t_class_refund_item → t_uni_refund_item   (老9列 / 统一11列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(9): id, create_time, create_by, update_time, update_by, is_deleted, refund_id, fee_type, amount

## sms_class.t_class_upgrade_apply → t_uni_upgrade_apply   (老30列 / 统一32列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(30): id, create_time, create_by, update_time, update_by, is_deleted, apply_no, student_id, student_no, student_name, from_dept_code, from_stage, from_class_id, from_class_name, to_dept_code, to_stage, to_class_id, to_class_name, exam_score, grade_snapshot, apply_status, applicant_id, applicant_name, apply_time, receive_time, receiver_id, receiver_name, reject_reason, source_system, source_id

## sms_class.t_class_transfer → t_uni_class_transfer   (老15列 / 统一44列)
  仅老表有(5): from_user_id, from_user_name, to_user_id, to_user_name, reason
  仅统一有(34): edu_stage, stage_code, student_id, student_no, student_name, from_class_id, from_class_name, to_class_id, to_class_name, transfer_reason, consult_no, create_by_name, class_code, class_status, stage, old_head_teacher_id, old_head_teacher_name, old_teacher_id, old_teacher_name, old_assistant_id, old_assistant_name, new_head_teacher_id, new_head_teacher_name, new_teacher_id, new_teacher_name, new_assistant_id, new_assistant_name, transfer_date, post_transfer_type, remark, snapshot_student_count, snapshot_attendance_rate, snapshot_student_list, snapshot_detail
  共有(10): id, create_time, create_by, update_time, update_by, is_deleted, class_id, class_name, transfer_type, transfer_time

## sms_class.t_class_notify → t_uni_notify   (老17列 / 统一37列)
  仅老表有(0): —
  仅统一有(20): edu_stage, stage_code, student_id, student_no, student_name, class_id, class_name, fee_type, fee_amount, expire_date, share_channel, notify_user_id, notify_user_name, notify_time, remark, notice_type, receiver_role, sender_id, sender_name, biz_type
  共有(17): id, create_time, create_by, update_time, update_by, is_deleted, notify_type, apply_type, biz_id, apply_no, title, content, receiver_id, receiver_name, is_read, read_time, link_path

## sms_class.t_class_consult_push → t_uni_consult_push   (老35列 / 统一37列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(35): id, create_time, create_by, update_time, update_by, is_deleted, consult_no, student_name, gender, phone, parent_phone, age, education, origin, graduate_school, home_address, intend_dept_code, intend_stage, intend_class_id, intend_class_name, remark, apply_status, push_time, receiver_id, receiver_name, receive_time, reject_reason, student_id, student_no, source_system, origin_student_id, from_class_id, from_class_name, is_repeat_in, transfer_reason

## sms_class.t_class_student_transfer → t_uni_class_transfer   (老16列 / 统一44列)
  仅老表有(0): —
  仅统一有(28): edu_stage, stage_code, create_by_name, class_id, class_name, class_code, class_status, stage, old_head_teacher_id, old_head_teacher_name, old_teacher_id, old_teacher_name, old_assistant_id, old_assistant_name, new_head_teacher_id, new_head_teacher_name, new_teacher_id, new_teacher_name, new_assistant_id, new_assistant_name, transfer_date, transfer_type, post_transfer_type, remark, snapshot_student_count, snapshot_attendance_rate, snapshot_student_list, snapshot_detail
  共有(16): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, from_class_id, from_class_name, to_class_id, to_class_name, transfer_reason, consult_no, transfer_time

## sms_class.t_class_grade → t_uni_exam_score   (老20列 / 统一39列)
  仅老表有(0): —
  仅统一有(19): edu_stage, stage_code, exam_type, exam_date, score_written, score_machine, score_interview, score_other, score_total, score_teacher_id, score_teacher_name, is_passed, custom_values, paper_score, written_avg, total_score, entry_by, entry_by_name, entry_time
  共有(20): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, class_id, class_name, exam_id, exam_name, written_score, machine_score, interview_score, comp_score, exam_result, analysis, remark

## sms_class.t_class_stage_log → t_uni_stage_log   (老17列 / 统一19列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(17): id, create_time, create_by, update_time, update_by, is_deleted, class_id, class_name, from_stage, from_stage_name, to_stage, to_stage_name, student_count, operate_time, operator_id, operator_name, reason

## sms_class.t_class_training_handoff → t_uni_handover   (老24列 / 统一48列)
  仅老表有(0): —
  仅统一有(24): edu_stage, stage_code, handover_role, from_user_id, from_user_name, to_user_id, to_user_name, handover_reason, handover_content, handover_time, arrange_user_id, arrange_user_name, source_system, source_class_id, source_class_name, source_stage, source_head_teacher_id, source_head_teacher_name, target_class_id, target_class_name, student_nos, receive_status, result_json, receive_time
  共有(24): id, create_time, create_by, update_time, update_by, is_deleted, handoff_no, class_id, class_name, dept_code, stage, stage_name, head_teacher_id, head_teacher_name, teacher_id, teacher_name, student_count, student_ids, to_module, handoff_status, handoff_time, operator_id, operator_name, remark

## sms_class.t_class_attendance_absent → t_uni_attendance_detail   (老13列 / 统一19列)
  仅老表有(0): —
  仅统一有(6): edu_stage, stage_code, class_id, attendance_date, parent_phone, attendance_status
  共有(13): id, create_time, create_by, update_time, update_by, is_deleted, attendance_id, student_id, student_no, student_name, class_name, phone, absent_reason

## sms_class_jh.t_class_attendance_detail → t_uni_attendance_detail   (老16列 / 统一19列)
  仅老表有(0): —
  仅统一有(3): edu_stage, stage_code, class_name
  共有(16): id, create_time, create_by, update_time, update_by, is_deleted, attendance_id, class_id, attendance_date, student_id, student_no, student_name, phone, parent_phone, attendance_status, absent_reason

## sms_job.t_job_attendance → t_uni_attendance   (老18列 / 统一32列)
  仅老表有(0): —
  仅统一有(14): edu_stage, stage_code, attendance_date, attendance_rate, should_count, actual_count, month_unqualified_count, teacher_id, teacher_name, head_teacher_id, head_teacher_name, file_url, present_count, absent_count
  共有(18): id, create_time, create_by, update_time, update_by, is_deleted, class_id, class_name, student_id, student_no, student_name, attend_date, attend_status, attend_type, reason, remark, registrar_id, registrar_name

## sms_job.t_job_attendance_summary → t_uni_attendance_summary   (老15列 / 统一17列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(15): id, create_time, create_by, update_time, update_by, is_deleted, class_id, class_name, attend_date, should_count, actual_count, absent_count, attendance_rate, head_teacher_name, teacher_name

## sms_class.t_class_urge_log → t_uni_urge_log   (老15列 / 统一17列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(15): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, amount, channel, remark, operator_id, operator_name, urge_time

## sms_common.t_class_urge_sync → t_uni_urge   (老26列 / 统一28列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(26): id, create_time, create_by, update_time, update_by, is_deleted, source_system, source_id, source_batch_no, source_update_time, sync_status, student_id, student_no, student_name, class_id, class_name, phone, parent_phone, head_teacher_id, head_teacher_name, fee_type, amount, expire_date, pay_status, urge_count, last_urge_time

## sms_common.t_class_fee_sync → t_uni_fee   (老26列 / 统一40列)
  仅老表有(1): amount
  仅统一有(15): edu_stage, stage_code, fee_amount, phone, parent_phone, head_teacher_id, head_teacher_name, due_date, call_reason, remark, call_status, handle_time, handle_remark, applicant_id, applicant_name
  共有(25): id, create_time, create_by, update_time, update_by, is_deleted, source_system, source_id, source_batch_no, source_update_time, sync_status, student_id, student_no, student_name, class_id, class_name, fee_type, paid_amount, pay_status, pay_date, expire_date, voucher_url, pay_method, period, dept_code

## sms_job.t_job_refund → t_uni_refund   (老28列 / 统一50列)
  仅老表有(0): —
  仅统一有(22): edu_stage, stage_code, fee_type, head_teacher_opinion, is_fee_used_up, refund_status, current_handler_name, apply_user_id, apply_user_name, approve_user_id, approve_user_name, approve_time, reject_reason, threshold_amount, pay_out_time, pay_out_voucher_no, apply_no, is_need_principal, applicant_id, applicant_name, apply_time, current_handler_role
  共有(28): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, class_id, class_name, dept_name, dept_code, head_teacher_id, head_teacher_name, refund_type, refund_type_name, refund_amount, apply_date, refund_reason, approval_id, approval_status, finance_remark, refund_time, remark, tuition_amount, accommodation_amount, meal_amount

## sms_job.t_job_approval → t_uni_approval_main   (老25列 / 统一27列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(25): id, create_time, create_by, update_time, update_by, is_deleted, biz_type, biz_id, biz_no, status, current_step, current_handler_role, current_handler_hint, applicant_id, applicant_name, applicant_role, student_id, student_no, student_name, class_id, class_name, dept_code, submit_time, finish_time, reject_reason

## sms_class_jh.t_class_checkout_apply → t_uni_checkout_apply   (老24列 / 统一26列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(24): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, class_id, class_name, room_id, room_no, bed_id, bed_no, checkout_reason, apply_user_id, apply_user_name, apply_time, apply_status, approve_user_id, approve_user_name, approve_time, reject_reason

## sms_class_jh.t_class_term → t_uni_class_term   (老12列 / 统一14列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(12): id, create_time, create_by, update_time, update_by, is_deleted, class_id, class_name, term_name, start_date, end_date, remark

## sms_class_jh.t_class_op_log → t_uni_op_log   (老17列 / 统一19列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(17): id, create_time, create_by, update_time, update_by, is_deleted, module, biz_type, biz_id, student_id, class_id, op_user_id, op_user_name, op_time, op_desc, before_value, after_value

## sms_class_jh.t_class_refund_log → t_uni_refund_log   (老14列 / 统一16列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(14): id, create_time, create_by, update_time, update_by, is_deleted, refund_id, node_status, approve_user_id, approve_user_name, approve_time, approve_result, reject_reason, remark

## sms_class_jh.t_class_setting → t_uni_setting   (老10列 / 统一12列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(10): id, create_time, create_by, update_time, update_by, is_deleted, setting_key, setting_name, setting_value, remark

## sms_class_jh.t_class_stage → t_uni_stage_def   (老11列 / 统一12列)
  仅老表有(0): —
  仅统一有(1): edu_stage
  共有(11): id, create_time, create_by, update_time, update_by, is_deleted, stage_code, stage_name, dept_code, study_months, sort_no

## sms_class_jh.t_student_base → t_uni_student_base_jh   (老30列 / 统一32列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(30): id, create_time, create_by, update_time, update_by, is_deleted, student_no, student_name, gender, age, dept_code, class_id, class_name, head_teacher_id, head_teacher_name, teacher_id, teacher_name, assistant_id, assistant_name, student_status, stage, phone, parent_phone, dorm_id, dorm_no, education, enroll_date, attendance_rate, repeat_count, remark

## sms_job.t_employment_log → t_uni_employment_log   (老19列 / 统一21列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(19): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, class_name, log_date, resume_count, interview_invite, interview_count, interview_time, company, position, salary, interview_situation

## sms_job.t_review → t_uni_review   (老19列 / 统一21列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(19): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, class_name, review_time, interview_time, position, salary, interview_conclusion, review_conclusion, audio_name, audio_data, detail

## sms_job.t_kpi_target → t_uni_kpi_target   (老9列 / 统一11列)
  仅老表有(0): —
  仅统一有(2): edu_stage, stage_code
  共有(9): id, create_time, create_by, update_time, update_by, is_deleted, target_rate, target_offer, target_resume

## sms_job.t_job_exam_score → t_uni_exam_score   (老23列 / 统一39列)
  仅老表有(0): —
  仅统一有(16): edu_stage, stage_code, exam_type, exam_date, score_written, score_machine, score_interview, score_other, score_total, score_teacher_id, score_teacher_name, is_passed, custom_values, written_score, comp_score, analysis
  共有(23): id, create_time, create_by, update_time, update_by, is_deleted, exam_id, exam_name, student_id, student_no, student_name, class_id, class_name, paper_score, machine_score, written_avg, interview_score, total_score, exam_result, remark, entry_by, entry_by_name, entry_time

## sms_job.t_job_fee_call → t_uni_fee   (老26列 / 统一40列)
  仅老表有(0): —
  仅统一有(14): edu_stage, stage_code, pay_status, pay_date, expire_date, voucher_url, source_system, source_id, period, source_batch_no, source_update_time, sync_status, paid_amount, pay_method
  共有(26): id, create_time, create_by, update_time, update_by, is_deleted, fee_type, student_id, student_no, student_name, phone, parent_phone, class_id, class_name, dept_code, head_teacher_id, head_teacher_name, fee_amount, due_date, call_reason, remark, call_status, handle_time, handle_remark, applicant_id, applicant_name

## sms_job.t_job_class_transfer → t_uni_class_transfer   (老32列 / 统一44列)
  仅老表有(0): —
  仅统一有(12): edu_stage, stage_code, student_id, student_no, student_name, from_class_id, from_class_name, to_class_id, to_class_name, consult_no, transfer_time, post_transfer_type
  共有(32): id, create_time, create_by, create_by_name, update_time, update_by, is_deleted, class_id, class_name, class_code, class_status, stage, old_head_teacher_id, old_head_teacher_name, old_teacher_id, old_teacher_name, old_assistant_id, old_assistant_name, new_head_teacher_id, new_head_teacher_name, new_teacher_id, new_teacher_name, new_assistant_id, new_assistant_name, transfer_date, transfer_type, transfer_reason, remark, snapshot_student_count, snapshot_attendance_rate, snapshot_student_list, snapshot_detail

## sms_job.t_job_training_handoff → t_uni_handover   (老23列 / 统一48列)
  仅老表有(0): —
  仅统一有(25): edu_stage, stage_code, class_id, class_name, handover_role, from_user_id, from_user_name, to_user_id, to_user_name, handover_reason, handover_content, handover_time, arrange_user_id, arrange_user_name, dept_code, stage, stage_name, head_teacher_id, head_teacher_name, teacher_id, teacher_name, student_ids, to_module, handoff_status, handoff_time
  共有(23): id, create_time, create_by, update_time, update_by, is_deleted, handoff_no, source_system, source_class_id, source_class_name, source_stage, source_head_teacher_id, source_head_teacher_name, target_class_id, target_class_name, student_count, student_nos, receive_status, result_json, receive_time, operator_id, operator_name, remark

## sms_job.t_job_notice → t_uni_notify   (老20列 / 统一37列)
  仅老表有(0): —
  仅统一有(17): edu_stage, stage_code, student_no, fee_type, fee_amount, expire_date, share_channel, notify_user_id, notify_user_name, notify_time, remark, notify_type, apply_type, apply_no, link_path, update_by, update_time
  共有(20): id, create_time, create_by, is_deleted, notice_type, title, content, receiver_id, receiver_name, receiver_role, sender_id, sender_name, biz_type, biz_id, class_id, class_name, student_id, student_name, is_read, read_time

## sms_class_jh.t_class_fee → t_uni_fee   (老21列 / 统一40列)
  仅老表有(0): —
  仅统一有(19): edu_stage, stage_code, phone, parent_phone, head_teacher_id, head_teacher_name, due_date, call_reason, remark, call_status, handle_time, handle_remark, applicant_id, applicant_name, source_batch_no, source_update_time, sync_status, paid_amount, pay_method
  共有(21): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, class_id, class_name, dept_code, fee_type, fee_amount, pay_status, pay_date, expire_date, voucher_url, source_system, source_id, period

## sms_class_jh.t_class_refund → t_uni_refund   (老29列 / 统一50列)
  仅老表有(0): —
  仅统一有(21): edu_stage, stage_code, apply_no, is_need_principal, applicant_id, applicant_name, apply_time, current_handler_role, dept_name, head_teacher_id, head_teacher_name, refund_type, refund_type_name, approval_id, approval_status, finance_remark, refund_time, remark, tuition_amount, accommodation_amount, meal_amount
  共有(29): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, class_id, class_name, dept_code, fee_type, refund_amount, refund_reason, head_teacher_opinion, apply_date, is_fee_used_up, refund_status, current_handler_name, apply_user_id, apply_user_name, approve_user_id, approve_user_name, approve_time, reject_reason, threshold_amount, pay_out_time, pay_out_voucher_no

## sms_class_jh.t_class_fee_notify → t_uni_notify   (老19列 / 统一37列)
  仅老表有(0): —
  仅统一有(18): edu_stage, stage_code, notify_type, apply_type, biz_id, apply_no, title, content, receiver_id, receiver_name, is_read, read_time, link_path, notice_type, receiver_role, sender_id, sender_name, biz_type
  共有(19): id, create_time, create_by, update_time, update_by, is_deleted, student_id, student_no, student_name, class_id, class_name, fee_type, fee_amount, expire_date, share_channel, notify_user_id, notify_user_name, notify_time, remark

## sms_class_jh.t_class_handover → t_uni_handover   (老18列 / 统一48列)
  仅老表有(0): —
  仅统一有(30): edu_stage, stage_code, handoff_no, dept_code, stage, stage_name, head_teacher_id, head_teacher_name, teacher_id, teacher_name, student_count, student_ids, to_module, handoff_status, handoff_time, operator_id, operator_name, remark, source_system, source_class_id, source_class_name, source_stage, source_head_teacher_id, source_head_teacher_name, target_class_id, target_class_name, student_nos, receive_status, result_json, receive_time
  共有(18): id, create_time, create_by, update_time, update_by, is_deleted, class_id, class_name, handover_role, from_user_id, from_user_name, to_user_id, to_user_name, handover_reason, handover_content, handover_time, arrange_user_id, arrange_user_name

## sms_class_jh.t_class_exam_score → t_uni_exam_score   (老24列 / 统一39列)
  仅老表有(0): —
  仅统一有(15): edu_stage, stage_code, class_name, exam_name, written_score, machine_score, interview_score, comp_score, analysis, paper_score, written_avg, total_score, entry_by, entry_by_name, entry_time
  共有(24): id, create_time, create_by, update_time, update_by, is_deleted, exam_id, exam_type, exam_date, class_id, student_id, student_no, student_name, score_written, score_machine, score_interview, score_other, score_total, score_teacher_id, score_teacher_name, exam_result, is_passed, custom_values, remark

## sms_class_jh.t_class_flow_log → t_uni_approval_log   (老14列 / 统一32列)
  仅老表有(0): —
  仅统一有(18): edu_stage, stage_code, apply_type, apply_no, biz_id, action, from_status, to_status, operator_id, operator_name, operator_role, opinion, operate_time, approval_id, biz_type, step, action_name, comment
  共有(14): id, create_time, create_by, update_time, update_by, is_deleted, flow_id, node_name, approve_user_id, approve_user_name, approve_time, approve_result, reject_reason, remark

## sms_class_jh.t_class_building → t_uni_dorm_building   (老14列 / 统一22列)
  仅老表有(0): —
  仅统一有(8): edu_stage, stage_code, dorm_no, building, floor, room_type, bed_total, remark
  共有(14): id, create_time, create_by, update_time, update_by, is_deleted, building_name, campus_name, floor_count, manager_name, manager_phone, dept_name, building_status, data_source

## sms_job.t_job_approval_log → t_uni_approval_log   (老14列 / 统一32列)
  仅老表有(0): —
  仅统一有(18): edu_stage, stage_code, flow_id, approve_user_id, approve_user_name, approve_time, approve_result, reject_reason, remark, apply_type, apply_no, from_status, to_status, opinion, operate_time, create_by, update_by, update_time
  共有(14): id, create_time, is_deleted, approval_id, biz_type, biz_id, step, node_name, operator_id, operator_name, operator_role, action, action_name, comment