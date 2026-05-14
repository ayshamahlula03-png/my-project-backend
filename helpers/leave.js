const { supabaseAdmin } = require('../supabase')

async function isPlannerOnLeave(name, date) {
  if (!name) return false
  const { data } = await supabaseAdmin
    .from('leave_requests')
    .select('id')
    .eq('designer_name', name)
    .eq('requester_role', 'planner')
    .eq('leave_date', date)
    .eq('status', 'approved')
    .maybeSingle()
  return !!data
}

// Cascade: Admin → task's Planner → another available Planner → Admin fallback
async function getLeaveApprover(date, taskPlannerName = null) {
  // 1. Admin on leave that date?
  const { data: adminLeave } = await supabaseAdmin
    .from('admin_leaves')
    .select('date')
    .eq('date', date)
    .maybeSingle()

  if (!adminLeave) return { role: 'admin', name: 'admin' }

  // 2. Route to task's planner if available
  if (taskPlannerName && !(await isPlannerOnLeave(taskPlannerName, date))) {
    return { role: 'planner', name: taskPlannerName }
  }

  // 3. Find another available planner
  const { data: allPlanners } = await supabaseAdmin
    .from('profiles')
    .select('name')
    .eq('role', 'planner')
    .order('name', { ascending: true })

  for (const planner of (allPlanners || [])) {
    if (!planner.name || planner.name === taskPlannerName) continue
    if (!(await isPlannerOnLeave(planner.name, date))) {
      return { role: 'planner', name: planner.name }
    }
  }

  // 4. Everyone on leave — admin fallback
  return { role: 'admin', name: 'admin' }
}

module.exports = { isPlannerOnLeave, getLeaveApprover }
