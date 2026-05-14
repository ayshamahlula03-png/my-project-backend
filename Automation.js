const csv = require('csv-parser')
const { supabase, supabaseAdmin } = require('./supabase')
const { getLatestCSV, downloadCSV } = require('./DriveService')

// ─── Designer skill mapping ───────────────────────────────
const REEL_DESIGNERS   = ['Divya', 'Sneha']
const POSTER_DESIGNERS = ['Lavanya', 'Arun']
const ADS_DESIGNERS    = ['Kiran', 'Vikram']

// ─── IST Date Helper ──────────────────────────────────────
function getISTDate() {
  const IST = new Date(new Date().getTime() + (5.5 * 60 * 60 * 1000))
  return IST.toISOString().split('T')[0]
}

// ─── Extract planner name from filename ───────────────────
function extractPlannerFromFilename(filename) {
  if (!filename) return 'System'
  return filename.split('_')[0] || 'System'
}

// ─── Get all designers with skill info ────────────────────
async function getDesignersWithSkills() {
  const { data: designers, error } = await supabase
    .from('profiles').select('id, name').eq('role', 'designer')

  if (error || !designers?.length) {
    console.log('⚠️ No designers found in profiles table!')
    return []
  }

  const { data: skills } = await supabaseAdmin.from('designer_skills').select('designer_id, skill')

  const skillMap = {}
  skills?.forEach(s => {
    if (!skillMap[s.designer_id]) skillMap[s.designer_id] = []
    skillMap[s.designer_id].push(s.skill.toLowerCase().trim())
  })

  const result = designers.map(d => ({
    designer_id:   d.id,
    designer_name: d.name,
    skills:        skillMap[d.id] || [],
  }))

  console.log(`👥 Found ${result.length} designers: ${result.map(d => d.designer_name).join(', ')}`)
  return result
}

// ─── Get workload per designer for a specific date ────────
// ★ KEY: Checks only tasks on that specific publish_date/end_date
async function getWorkloadForDate(designers, targetDate) {
  const { data: tasks } = await supabase
    .from('tasks')
    .select('assigned_designer_id, status')
    .or(`publish_date.eq.${targetDate},end_date.eq.${targetDate}`)
    .in('status', ['Pending', 'Assigned', 'In Progress', 'Submitted'])

  const count = {}
  designers.forEach(d => { count[d.designer_id] = 0 })
  tasks?.forEach(t => {
    if (t.assigned_designer_id) {
      count[t.assigned_designer_id] = (count[t.assigned_designer_id] || 0) + 1
    }
  })

  console.log(`\n📊 Workload on ${targetDate}:`)
  designers.forEach(d => console.log(`   ${d.designer_name}: ${count[d.designer_id]} tasks`))

  return count
}

// ─── Pick best designer for a task ───────────────────────
// Rules (strict order):
// 1. Type-based filter: Reel→[Divya,Sneha] | Poster→[Lavanya,Arun] | Ads→[Kiran,Vikram]
// 2. On that date, who is FREE (0 tasks)? → assign first free person
// 3. All busy? → assign to person with LEAST task count
// 4. Tied count? → assign to first in list (stable, no deadline-based picking)
function pickBestDesigner(designers, workloadCount, taskType, publishDate) {
  const normalizedType = (taskType || '').toLowerCase().trim()
  console.log(`\n🎯 Picking for: "${taskType}" on ${publishDate}`)

  // Step 1: Type-based candidates
  let candidates = []

  if (normalizedType.includes('reel')) {
    candidates = designers.filter(d => REEL_DESIGNERS.includes(d.designer_name))
    console.log(`   🎬 Reel → [${candidates.map(d => d.designer_name).join(', ')}]`)
  } else if (normalizedType.includes('poster')) {
    candidates = designers.filter(d => POSTER_DESIGNERS.includes(d.designer_name))
    console.log(`   🖼️ Poster → [${candidates.map(d => d.designer_name).join(', ')}]`)
  } else if (normalizedType.includes('ads') || normalizedType.includes('google')) {
    candidates = designers.filter(d => ADS_DESIGNERS.includes(d.designer_name))
    console.log(`   📢 Ads → [${candidates.map(d => d.designer_name).join(', ')}]`)
  } else {
    // DB skill match
    candidates = designers.filter(d =>
      d.skills.some(s => normalizedType.includes(s) || s.includes(normalizedType))
    )
    if (!candidates.length) {
      console.log(`   ℹ️ No skill match — all designers eligible`)
      candidates = [...designers]
    }
  }

  if (!candidates.length) { console.log(`   ❌ No candidates!`); return null }

  // Step 2: FREE on that date (0 tasks) → first free wins
  const free = candidates.filter(d => (workloadCount[d.designer_id] || 0) === 0)
  if (free.length > 0) {
    console.log(`   ✅ FREE: ${free.map(d => d.designer_name).join(', ')} → assigning to ${free[0].designer_name}`)
    return free[0]
  }

  // Step 3: All busy → least task count
  const sorted = [...candidates].sort(
    (a, b) => (workloadCount[a.designer_id] || 0) - (workloadCount[b.designer_id] || 0)
  )
  const best = sorted[0]
  console.log(`   ⚖️ All busy → least: ${best.designer_name} (${workloadCount[best.designer_id]} tasks)`)
  return best
}

// ─── Drive cron automation ────────────────────────────────
async function runAutomation() {
  console.log('\n🚀 Automation starting (Drive cron)...')
  try {
    const file = await getLatestCSV()
    if (!file) { console.log('No new CSV found in Drive'); return }
    console.log(`📄 Found CSV: ${file.name}`)

    const plannerName = extractPlannerFromFilename(file.name)
    const stream = await downloadCSV(file.id)
    const rows   = await parseCSV(stream)
    console.log(`📊 Total rows: ${rows.length}`)

    const designers = await getDesignersWithSkills()
    if (!designers.length) return

    const today   = getISTDate()
    let assigned  = 0

    for (const row of rows) {
      const taskId = row['Task ID'] || row.Task_ID || row.task_id
      if (!taskId) continue

      // Skip if already exists
      const { data: existing } = await supabaseAdmin.from('tasks').select('id').eq('task_id', taskId).single()
      if (existing) continue

      const taskType    = row['Task Type']    || row.Task_Type    || row.task_type    || ''
      const clientName  = row['Client Name']  || row.Client_Name  || row.client_name  || ''
      const requirements = row['Requirements'] || row.requirements || ''

      // ★ FIX: Use end_date as publish_date if no Publish Date column
      const publishDate = row['Publish Date'] || row.publish_date ||
                          row['End Date']     || row.end_date     || today

      console.log(`\n📋 Processing: ${taskId} | ${taskType} | ${clientName} | date: ${publishDate}`)

      // Date-wise workload check for this specific date
      const workloadCount = await getWorkloadForDate(designers, publishDate)

      const best = pickBestDesigner(designers, workloadCount, taskType, publishDate)
      if (!best) {
        console.log(`❌ No designer found for ${taskId}`)
        continue
      }

      const { error: insertError } = await supabaseAdmin.from('tasks').insert({
        task_id:              taskId,
        client_name:          clientName,
        task_type:            taskType,
        end_date:             publishDate,
        publish_date:         publishDate,   // ★ Always set publish_date = end_date
        planner_name:         plannerName,
        requirements:         requirements || null,
        assigned_designer:    best.designer_name,
        assigned_designer_id: best.designer_id,
        status:               'Assigned',
        is_today:             publishDate === today,
        created_at:           new Date().toISOString(),
      })

      if (insertError) {
        console.error(`❌ Insert error ${taskId}:`, insertError.message)
        continue
      }

      // Notify designer
      await supabaseAdmin.from('notifications').insert({
        designer_name: best.designer_name,
        planner_name:  plannerName,
        task_id:       taskId,
        message: `📋 New task: "${taskType}" for ${clientName} — Due: ${publishDate}`,
        type: 'task_assigned',
        is_read: false,
        created_at: new Date().toISOString(),
      })

      assigned++
      console.log(`✅ ${taskId} → ${best.designer_name}`)
    }

    // Log sync
    await supabaseAdmin.from('sync_logs').insert({
      file_name:   file.name,
      rows_synced: assigned,
      status:      'success',
      uploaded_by: plannerName,
    })
    console.log(`\n🎉 Drive automation done! ${assigned} tasks assigned.`)
  } catch (err) {
    console.error('❌ Automation error:', err.message)
    await supabaseAdmin.from('sync_logs').insert({
      file_name: 'unknown', rows_synced: 0, status: 'error'
    })
  }
}

// ─── Buffer automation (planner dashboard upload) ─────────
async function runAutomationFromBuffer(buffer, plannerName) {
  console.log(`\n🚀 Processing upload from planner: ${plannerName}`)

  const rows = await parseCSVFromBuffer(buffer)
  console.log(`📊 Total rows in CSV: ${rows.length}`)

  if (!rows.length) {
    console.log('⚠️ No rows found in CSV!')
    return { inserted: 0, skipped: 0, total: 0 }
  }

  const designers = await getDesignersWithSkills()
  if (!designers.length) {
    console.log('❌ No designers found!')
    return { inserted: 0, skipped: 0, total: rows.length }
  }

  const today    = getISTDate()
  let inserted   = 0
  let skipped    = 0

  for (const row of rows) {
    // Parse all possible column name formats
    const taskId      = row['Task ID']      || row.Task_ID      || row.task_id      || ''
    const clientName  = row['Client Name']  || row.Client_Name  || row.client_name  || ''
    const taskType    = row['Task Type']    || row.Task_Type    || row.task_type    || ''
    const requirements = row['Requirements'] || row.requirements || ''

    // ★ FIX: publish_date = end_date as fallback (many CSVs only have End Date)
    const publishDate = row['Publish Date'] || row.publish_date ||
                        row['End Date']     || row.end_date     || today

    const clientId = row['Client ID'] || row.Client_ID || row.client_id || null

    // Validate required fields
    if (!taskId) {
      console.log(`⏭️ Skipping row — no Task ID`)
      skipped++
      continue
    }

    // Check if task already exists
    const { data: existing } = await supabaseAdmin.from('tasks').select('id').eq('task_id', taskId).single()
    if (existing) {
      console.log(`⏭️ ${taskId} already exists — skipping`)
      skipped++
      continue
    }

    console.log(`\n📋 Processing: ${taskId} | ${taskType} | ${clientName} | ${publishDate}`)

    // ★ Date-wise workload check for this specific publishDate
    const workloadCount = await getWorkloadForDate(designers, publishDate)

    const best = pickBestDesigner(designers, workloadCount, taskType, publishDate)
    if (!best) {
      console.log(`❌ No suitable designer for ${taskId}`)
      skipped++
      continue
    }

    // Insert task
    const { error: insertError } = await supabaseAdmin.from('tasks').insert({
      task_id:              taskId,
      client_name:          clientName,
      client_id:            clientId,
      task_type:            taskType,
      end_date:             publishDate,
      publish_date:         publishDate,   // ★ Always set publish_date
      planner_name:         plannerName,
      requirements:         requirements || null,
      assigned_designer:    best.designer_name,
      assigned_designer_id: best.designer_id,
      status:               'Assigned',
      is_today:             publishDate === today,
      created_at:           new Date().toISOString(),
    })

    if (insertError) {
      console.error(`❌ Insert error ${taskId}:`, insertError.message)
      skipped++
      continue
    }

    // Notify designer
    await supabaseAdmin.from('notifications').insert({
      designer_name: best.designer_name,
      planner_name:  plannerName,
      task_id:       taskId,
      message: `📋 New task: "${taskType}" for ${clientName} — Due: ${publishDate}`,
      type: 'task_assigned',
      is_read: false,
      created_at: new Date().toISOString(),
    })

    inserted++
    console.log(`✅ ${taskId} (${taskType}, ${publishDate}) → ${best.designer_name}`)
  }

  console.log(`\n📊 Summary: ✅ Inserted=${inserted} | ⏭️ Skipped=${skipped} | Total=${rows.length}`)
  return { inserted, skipped, total: rows.length }
}

// ─── CSV parsers ──────────────────────────────────────────
function parseCSV(stream) {
  return new Promise((resolve, reject) => {
    const rows = []
    stream
      .pipe(csv())
      .on('data', r => rows.push(r))
      .on('end',  () => resolve(rows))
      .on('error', reject)
  })
}

function parseCSVFromBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const results = []
    const { Readable } = require('stream')
    Readable.from(buffer.toString())
      .pipe(csv())
      .on('data', d => results.push(d))
      .on('end',  () => resolve(results))
      .on('error', reject)
  })
}

module.exports = { runAutomation, runAutomationFromBuffer }