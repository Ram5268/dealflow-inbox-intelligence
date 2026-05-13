export async function register() {
  // Only run in Node.js runtime (not edge), and only on server
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startBackgroundJobs } = await import('./lib/backgroundJobs')
    startBackgroundJobs()
  }
}
