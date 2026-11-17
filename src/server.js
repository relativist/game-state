import {createPool,migrate} from './db.js';
import {createApp} from './app.js';
const pool = createPool(process.env.DATABASE_URL);
await migrate(pool);
const server = createApp(pool,{
  origins:(process.env.CORS_ORIGINS || '').split(',').map(x=>x.trim()).filter(Boolean),
  trustProxy:process.env.TRUST_PROXY === '1',
  sessionDays:Number(process.env.SESSION_DAYS || 30)
});
server.listen(Number(process.env.PORT || 3000),'0.0.0.0',()=>console.log('game-state listening'));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
  server.close(async ()=>{await pool.end();process.exit(0);});
  setTimeout(()=>process.exit(1),10000).unref();
});
