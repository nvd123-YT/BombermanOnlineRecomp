const DCNET_PLAYERS_URL = "https://dcnet.flyca.st/status/api/players";
const BOMBERMAN_GAME_ID = "bomberman";
const SESSION_GAP_MS = 10 * 60 * 1000;
const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const STALE_AFTER_MS = 3 * 60 * 1000;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store, max-age=0",
    "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type"
  }});
}
function textIdentity(player) {
  const candidates = [
    ["user-id", player.userId ?? player.userID ?? player.user_id],
    ["account-id", player.accountId ?? player.accountID ?? player.account_id],
    ["login", player.loginName ?? player.login_name], ["name", player.name]
  ];
  for (const [kind, value] of candidates) if (value !== undefined && value !== null && String(value).trim() !== "")
    return kind + ":" + String(value).normalize("NFKC").trim().toLowerCase();
  return null;
}
async function hashIdentity(identity, secret) {
  if (!secret) throw new Error("PLAYER_HASH_SECRET is not configured.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2,"0")).join("");
}
async function saveState(db,key,value) {
  await db.prepare("INSERT INTO collector_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key,value).run();
}
async function collect(env) {
  if (!env.DB) throw new Error("D1 binding DB is missing.");
  if (!env.PLAYER_HASH_SECRET) throw new Error("PLAYER_HASH_SECRET is not configured.");
  const response = await fetch(DCNET_PLAYERS_URL, {headers:{Accept:"application/json","Cache-Control":"no-cache"},cf:{cacheTtl:0,cacheEverything:false}});
  if (!response.ok) throw new Error("DCNet player feed returned HTTP "+response.status+".");
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("DCNet player feed was not a JSON array.");
  const identities = new Map();
  for (const player of payload) {
    if (!player || String(player.gameId || "").toLowerCase() !== BOMBERMAN_GAME_ID) continue;
    const identity = textIdentity(player);
    if (identity) identities.set(await hashIdentity(identity,env.PLAYER_HASH_SECRET),true);
  }
  const now = new Date(), stamp = now.toISOString(), today = stamp.slice(0,10), nowMs = now.getTime();
  for (const playerKey of identities.keys()) {
    const existing = await env.DB.prepare("SELECT last_seen FROM players WHERE player_key=?").bind(playerKey).first();
    if (!existing) {
      await env.DB.prepare("INSERT INTO players (player_key,first_seen,last_seen,total_sessions) VALUES (?,?,?,1)").bind(playerKey,stamp,stamp).run();
      await env.DB.prepare("INSERT INTO player_sessions (player_key,started_at,last_seen) VALUES (?,?,?)").bind(playerKey,stamp,stamp).run();
    } else {
      const lastMs = Date.parse(existing.last_seen), newSession = !Number.isFinite(lastMs) || nowMs-lastMs >= SESSION_GAP_MS;
      await env.DB.prepare("UPDATE players SET last_seen=?,total_sessions=total_sessions+? WHERE player_key=?").bind(stamp,newSession?1:0,playerKey).run();
      if (newSession) await env.DB.prepare("INSERT INTO player_sessions (player_key,started_at,last_seen) VALUES (?,?,?)").bind(playerKey,stamp,stamp).run();
      else await env.DB.prepare("UPDATE player_sessions SET last_seen=? WHERE id=(SELECT id FROM player_sessions WHERE player_key=? ORDER BY started_at DESC LIMIT 1)").bind(stamp,playerKey).run();
    }
    await env.DB.prepare("INSERT INTO daily_players (day,player_key,last_seen) VALUES (?,?,?) ON CONFLICT(day,player_key) DO UPDATE SET last_seen=excluded.last_seen").bind(today,playerKey,stamp).run();
  }
  await env.DB.prepare("INSERT INTO player_snapshots (captured_at,online_count) VALUES (?,?)").bind(stamp,identities.size).run();
  await saveState(env.DB,"last_success_at",stamp);
  await saveState(env.DB,"last_error","");
  return {capturedAt:stamp,onlineCount:identities.size};
}
async function collectSafely(env) {
  try { console.log("Bomberman collection:",JSON.stringify(await collect(env))); }
  catch(error) {
    console.error("Bomberman collection failed:",error);
    try { await saveState(env.DB,"last_error",String(error?.message || error).slice(0,300)); } catch(stateError) { console.error("Could not save collector error:",stateError); }
  }
}
async function readStats(env) {
  const db=env.DB;if(!db)throw new Error("D1 binding DB is missing.");
  const today=new Date().toISOString().slice(0,10), cutoff=new Date(Date.now()-ONLINE_WINDOW_MS).toISOString();
  const [unique,sessions,peak,todayCount,last,start,history,active,recent,lastError]=await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM players").first(),
    db.prepare("SELECT COUNT(*) AS count FROM player_sessions").first(),
    db.prepare("SELECT COALESCE(MAX(online_count),0) AS count FROM player_snapshots").first(),
    db.prepare("SELECT COUNT(*) AS count FROM daily_players WHERE day=?").bind(today).first(),
    db.prepare("SELECT value FROM collector_state WHERE key='last_success_at'").first(),
    db.prepare("SELECT MIN(first_seen) AS first_seen FROM players").first(),
    db.prepare("SELECT day,COUNT(*) AS unique_players FROM daily_players WHERE day>=date('now','-29 days') GROUP BY day ORDER BY day ASC").all(),
    db.prepare("SELECT player_key,first_seen,last_seen,total_sessions FROM players WHERE last_seen>=? ORDER BY last_seen DESC LIMIT 30").bind(cutoff).all(),
    db.prepare("SELECT player_key,first_seen,last_seen,total_sessions FROM players ORDER BY last_seen DESC LIMIT 20").all(),
    db.prepare("SELECT value FROM collector_state WHERE key='last_error'").first()
  ]);
  const lastUpdated=last?.value||null,lastMs=lastUpdated?Date.parse(lastUpdated):NaN,stale=!Number.isFinite(lastMs)||Date.now()-lastMs>STALE_AFTER_MS;
  const publicPlayer=row=>({playerCode:row.player_key.slice(0,10),firstSeen:row.first_seen,lastSeen:row.last_seen,totalSessions:row.total_sessions});
  const dailyMap=new Map((history?.results||[]).map(row=>[row.day,Number(row.unique_players)])),dailyActivity=[];
  for(let offset=29;offset>=0;offset--){const date=new Date();date.setUTCHours(0,0,0,0);date.setUTCDate(date.getUTCDate()-offset);const day=date.toISOString().slice(0,10);dailyActivity.push({day,uniquePlayers:dailyMap.get(day)||0});}
  let onlineNow=null;if(!stale){const snapshot=await db.prepare("SELECT online_count FROM player_snapshots ORDER BY captured_at DESC LIMIT 1").first();onlineNow=Number(snapshot?.online_count??0);}
  return {ok:true,game:"Bomberman Online",gameId:BOMBERMAN_GAME_ID,onlineNow,uniquePlayers:Number(unique?.count||0),peakConcurrent:Number(peak?.count||0),totalSessions:Number(sessions?.count||0),playersToday:Number(todayCount?.count||0),collectionStartedAt:start?.first_seen||null,lastUpdated,stale,lastCollectionError:lastError?.value?"Latest collection failed; previous statistics are retained.":null,dailyActivity,activePlayers:stale?[]:(active?.results||[]).map(publicPlayer),recentPlayers:(recent?.results||[]).map(publicPlayer)};
}
export default {
  async scheduled(_controller,env,ctx){ctx.waitUntil(collectSafely(env));},
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:{"access-control-allow-origin":"*","access-control-allow-methods":"GET, OPTIONS","access-control-allow-headers":"Content-Type"}});
    if(request.method!=="GET")return jsonResponse({ok:false,error:"Method not allowed."},405);
    if(url.pathname==="/health")return jsonResponse({ok:true,service:"bombermanonlinerecomp",gameId:BOMBERMAN_GAME_ID});
    if(url.pathname==="/api/stats"){try{return jsonResponse(await readStats(env));}catch(error){console.error("Stats API failed:",error);return jsonResponse({ok:false,error:"Statistics database is not ready. Check collector setup."},503);}}
    return jsonResponse({ok:false,error:"Not found."},404);
  }
};