const { listFolders } = require('./DriveService')

async function test() {
  console.log('🔍 Testing Drive connection...')
  console.log('================================')
  
  try {
    const folders = await listFolders()
    console.log('✅ Success!')
    console.log(`📁 Found ${folders.length} folders:`)
    folders.forEach(f => console.log(`   - ${f.name} (${f.id})`))
  } catch (err) {
    console.log('❌ Error:', err.message)
    console.log('\n🔧 Possible fixes:')
    console.log('1. Check credentials.json exists in backend folder')
    console.log('2. Share Drive folder with service account email')
    console.log('3. Enable Drive API in Google Cloud Console')
    console.log('4. Check GOOGLE_DRIVE_FOLDER_ID in .env')
  }
}

test()