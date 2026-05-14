const cron         = require('node-cron')
const { supabase, supabaseAdmin } = require('../supabase')
const { getISTDate, getISTTomorrow } = require('../helpers/ist')
const { runAutomation } = require('../Automation')

const REEL_DESIGNERS = ['Divya', 'Sneha']

async function updateIsTodayFlags() {
  const today = getISTDate()
  console.log(`🔄 Updating is_today flags for ${today}...`)
  try {
    await supabaseAdmin.from('tasks').update({ is_today: false }).neq('task_id', '')
    await supabaseAdmin.from('tasks').update({ is_today: true })
      .or(`end_date.eq.${today},publish_date.eq.${today}`)
      .in('status', ['Pending', 'Assigned', 'In Progress', 'Submitted'])
    console.log(`✅ is_today updated for ${today}`)
  } catch (err) {
    console.error('is_today update error:', err.message)
  }
}

function registerCrons() {
  // Midnight IST = 18:30 UTC — update is_today flags
  cron.schedule('30 18 * * *', async () => {
    console.log('🌅 Midnight IST: updating is_today...')
    await updateIsTodayFlags()
  }, { timezone: 'UTC' })

  // 8 AM IST = 02:30 UTC — daily task reminders to designers
  cron.schedule('30 2 * * *', async () => {
    const today = getISTDate()
    const { data: tasks } = await supabaseAdmin.from('tasks').select('*')
      .or(`end_date.eq.${today},publish_date.eq.${today}`)
      .in('status', ['Pending', 'Assigned'])

    for (const task of tasks || []) {
      await supabaseAdmin.from('notifications').insert({
        designer_name: task.assigned_designer,
        task_id:       task.task_id,
        message:       `📋 Today's task: "${task.task_type}" for ${task.client_name} — Due: ${task.end_date}`,
        type:          'daily_reminder',
        is_read:       false,
        created_at:    new Date().toISOString(),
      })
    }
    console.log(`🔔 8AM reminders: ${tasks?.length || 0} tasks`)
  }, { timezone: 'UTC' })

  // 9 AM IST = 03:30 UTC — 2-day deadline reminder
  cron.schedule('30 3 * * *', async () => {
    const twoDays = new Date(new Date().getTime() + (5.5 * 60 * 60 * 1000))
    twoDays.setDate(twoDays.getDate() + 2)
    const twoDaysStr = twoDays.toISOString().split('T')[0]

    const { data: tasks } = await supabaseAdmin.from('tasks').select('*')
      .eq('end_date', twoDaysStr).in('status', ['Pending', 'Assigned', 'In Progress'])

    for (const task of tasks || []) {
      await supabaseAdmin.from('notifications').insert({
        designer_name: task.assigned_designer,
        task_id:       task.task_id,
        message:       `⏰ 2-day deadline: "${task.task_type}" for ${task.client_name} — Due: ${task.end_date}`,
        type:          'reminder',
        is_read:       false,
        created_at:    new Date().toISOString(),
      })
    }
    console.log(`⏰ 2-day reminders: ${tasks?.length || 0}`)
  }, { timezone: 'UTC' })

  // 10 AM IST = 04:30 UTC — No-show check & auto-reassign
  cron.schedule('30 4 * * *', async () => {
    const today = getISTDate()
    console.log(`\n⚡ 10AM no-show check for ${today}...`)

    const { data: designers } = await supabaseAdmin.from('profiles').select('*').eq('role', 'designer')

    for (const designer of designers || []) {
      const lastLoginDate = designer.last_login?.split('T')[0]
      if (lastLoginDate === today) continue

      const { data: leave } = await supabaseAdmin.from('leave_requests').select('*')
        .eq('designer_id', designer.id).eq('leave_date', today).eq('status', 'approved').maybeSingle()
      if (leave) continue

      const { data: tasks } = await supabaseAdmin.from('tasks').select('*')
        .eq('assigned_designer', designer.name)
        .in('status', ['Pending', 'Assigned', 'In Progress'])
        .or(`end_date.eq.${today},publish_date.eq.${today}`)
      if (!tasks?.length) continue

      const { data: others } = await supabaseAdmin.from('profiles').select('*')
        .eq('role', 'designer').neq('id', designer.id)
      if (!others?.length) continue

      for (let i = 0; i < tasks.length; i++) {
        const task     = tasks[i]
        const isReel   = (task.task_type || '').toLowerCase().includes('reel')
        const reelOths = others.filter(d => REEL_DESIGNERS.includes(d.name))
        const target   = isReel && reelOths.length ? reelOths[i % reelOths.length] : others[i % others.length]
        if (target) {
          await supabaseAdmin.from('tasks').update({
            assigned_designer: target.name, assigned_designer_id: target.id, status: 'Assigned',
          }).eq('task_id', task.task_id)
          await supabaseAdmin.from('notifications').insert({
            designer_name: target.name,
            message:       `🔄 "${task.task_type}" for ${task.client_name} reassigned (${designer.name} no login by 10AM)`,
            is_read: false, created_at: new Date().toISOString(),
          })
        }
      }

      await supabaseAdmin.from('notifications').insert({
        planner_name: 'admin',
        message:      `🚨 ${designer.name} didn't login by 10AM. ${tasks.length} tasks reassigned.`,
        is_read: false, created_at: new Date().toISOString(),
      })
      console.log(`  ✅ ${designer.name}: ${tasks.length} reassigned`)
    }
  }, { timezone: 'UTC' })

  // 4 PM IST = 10:30 UTC — Deadline reminder
  cron.schedule('30 10 * * *', async () => {
    const today = getISTDate()
    console.log(`\n🔔 4PM deadline reminder check for ${today}...`)

    const { data: pendingTasks } = await supabase.from('tasks').select('*')
      .eq('end_date', today).in('status', ['Pending', 'Assigned', 'In Progress'])

    if (!pendingTasks?.length) {
      console.log('✅ All tasks submitted — no 4PM reminder needed')
      return
    }

    const byDesigner = {}
    pendingTasks.forEach(t => {
      if (!t.assigned_designer) return
      if (!byDesigner[t.assigned_designer]) byDesigner[t.assigned_designer] = []
      byDesigner[t.assigned_designer].push(t)
    })
    for (const [name, tasks] of Object.entries(byDesigner)) {
      await supabaseAdmin.from('notifications').insert({
        designer_name: name,
        message:       `⏰ 4PM Reminder: ${tasks.length} task${tasks.length > 1 ? 's' : ''} still pending! Submit before 6 PM — ${tasks.map(t => t.client_name).join(', ')}`,
        type:          'deadline_reminder',
        is_read:       false,
        created_at:    new Date().toISOString(),
      })
    }

    const byPlanner = {}
    pendingTasks.forEach(t => {
      if (!t.planner_name) return
      if (!byPlanner[t.planner_name]) byPlanner[t.planner_name] = []
      byPlanner[t.planner_name].push(t)
    })
    for (const [name, tasks] of Object.entries(byPlanner)) {
      await supabaseAdmin.from('notifications').insert({
        planner_name: name,
        message:      `⚠️ 4PM Alert: ${tasks.length} task${tasks.length > 1 ? 's' : ''} still not submitted — ${tasks.map(t => `${t.client_name} (${t.assigned_designer})`).join(', ')}`,
        type:         'deadline_reminder',
        is_read:      false,
        created_at:   new Date().toISOString(),
      })
    }

    await supabaseAdmin.from('notifications').insert({
      planner_name: 'admin',
      message:      `⚠️ 4PM Alert: ${pendingTasks.length} task${pendingTasks.length > 1 ? 's' : ''} pending submission today`,
      type:         'deadline_reminder',
      is_read:      false,
      created_at:   new Date().toISOString(),
    })

    console.log(`✅ 4PM reminders sent — ${pendingTasks.length} tasks pending`)
  }, { timezone: 'UTC' })

  // Every 30 min — Drive CSV check
  cron.schedule('*/30 * * * *', async () => {
    console.log('⏰ Drive CSV check...')
    await runAutomation()
  })

  console.log('✅ All cron jobs registered')
}

module.exports = { registerCrons, updateIsTodayFlags }
