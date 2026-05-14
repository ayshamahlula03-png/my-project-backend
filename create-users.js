const supabase = require('./supabase')

const users = [
  { email: 'karthik@agency.com', password: 'password123', name: 'Karthik', role: 'planner' },
  { email: 'preethi@agency.com', password: 'password123', name: 'Preethi', role: 'planner' },
  { email: 'ramesh@agency.com', password: 'password123', name: 'Ramesh', role: 'admin' },
  { email: 'arun@agency.com', password: 'password123', name: 'Arun', role: 'designer' },
  { email: 'divya@agency.com', password: 'password123', name: 'Divya', role: 'designer' },
  { email: 'kiran@agency.com', password: 'password123', name: 'Kiran', role: 'designer' },
  { email: 'sneha@agency.com', password: 'password123', name: 'Sneha', role: 'designer' },
  { email: 'vikram@agency.com', password: 'password123', name: 'Vikram', role: 'designer' },
  { email: 'lavanya@agency.com', password: 'password123', name: 'Lavanya', role: 'designer' }
]

async function createUsers() {
  for (const user of users) {
    console.log(`Creating ${user.email}...`)
    
    const { data, error } = await supabase.auth.admin.createUser({
      email: user.email,
      password: user.password,
      email_confirm: true,
      user_metadata: {
        name: user.name,
        role: user.role
      }
    })
    
    if (error) {
      console.error(`Error creating ${user.email}:`, error.message)
    } else {
      console.log(`✅ Created ${user.email}`)
    }
  }
}

createUsers()