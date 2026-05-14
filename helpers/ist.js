function getISTDate() {
  const IST = new Date(new Date().getTime() + (5.5 * 60 * 60 * 1000))
  return IST.toISOString().split('T')[0]
}

function getISTTomorrow() {
  const IST = new Date(new Date().getTime() + (5.5 * 60 * 60 * 1000))
  IST.setDate(IST.getDate() + 1)
  return IST.toISOString().split('T')[0]
}

function isAfter430PM() {
  const now     = new Date()
  const IST     = new Date(now.getTime() + (5.5 * 60 * 60 * 1000))
  const hours   = IST.getUTCHours()
  const minutes = IST.getUTCMinutes()
  const result  = hours > 16 || (hours === 16 && minutes >= 30)
  console.log(`⏰ IST Time: ${hours}:${String(minutes).padStart(2,'0')} | After 4:30PM: ${result}`)
  return result
}

function generateUploadToken(userId) {
  const { v4: uuidv4 } = require('uuid')
  const now     = new Date()
  const date    = now.toISOString().slice(0, 10).replace(/-/g, '')
  const time    = now.toTimeString().slice(0, 8).replace(/:/g, '')
  const shortId = (userId || 'UNKNOWN').slice(0, 8).toUpperCase()
  const random  = uuidv4().split('-')[0].toUpperCase()
  return `PLN-${shortId}-${date}-${time}-${random}`
}

module.exports = { getISTDate, getISTTomorrow, isAfter430PM, generateUploadToken }
