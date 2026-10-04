/*
 * MyFastingDiet backend.
 * Express + SQLite keeps the MVP small and easy to understand.
 * Passwords are hashed with bcryptjs; sessions protect private routes.
 */
require("dotenv").config();
const path=require("path"),fs=require("fs"),express=require("express"),session=require("express-session");
const Database=require("better-sqlite3"),bcrypt=require("bcryptjs");
const app=express(),PORT=process.env.PORT||3000;
const dataDir=path.join(__dirname,"data"); if(!fs.existsSync(dataDir))fs.mkdirSync(dataDir,{recursive:true});
const db=new Database(path.join(dataDir,"myfasting.db")); db.pragma("journal_mode=WAL");

// Core user/profile/tracking tables.
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'USER',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS profiles(user_id INTEGER PRIMARY KEY,weight REAL,height REAL,activity_level TEXT,diet_type TEXT DEFAULT 'normal',calorie_limit INTEGER,fasting_model TEXT DEFAULT '16:8');
CREATE TABLE IF NOT EXISTS allergies(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS user_allergies(user_id INTEGER,allergy_id INTEGER,PRIMARY KEY(user_id,allergy_id));
CREATE TABLE IF NOT EXISTS water_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,amount_ml INTEGER,entry_date TEXT);
CREATE TABLE IF NOT EXISTS weight_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,weight REAL,entry_date TEXT);
CREATE TABLE IF NOT EXISTS feedback(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,rating INTEGER,message TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS relaxation_exercises(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,description TEXT,duration_minutes INTEGER);
`);

["Gluten","Laktose","Milch","Erdnüsse","Nüsse","Soja","Ei","Fisch","Schalentiere"].forEach(x=>db.prepare("INSERT OR IGNORE INTO allergies(name) VALUES(?)").run(x));
if(!db.prepare("SELECT COUNT(*) c FROM relaxation_exercises").get().c){
 const add=db.prepare("INSERT INTO relaxation_exercises(title,description,duration_minutes) VALUES(?,?,?)");
 add.run("Box Breathing","4 Sekunden einatmen, halten, ausatmen und halten.",4);
 add.run("Körperreise","Aufmerksamkeit nacheinander auf Füße, Beine, Bauch, Schultern und Gesicht lenken.",7);
 add.run("Nach dem Training","Ruhig atmen und Schultern sowie Kiefer bewusst lockern.",5);
}

// Initial admin is created once. Change these environment values before production.
const adminEmail=process.env.ADMIN_EMAIL||"admin@myfasting.local",adminPassword=process.env.ADMIN_PASSWORD||"ChangeMe123!";
if(!db.prepare("SELECT id FROM users WHERE email=?").get(adminEmail))
 db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'ADMIN')").run("MyFasting Admin",adminEmail,bcrypt.hashSync(adminPassword,12));

app.use(express.json()); app.use(express.urlencoded({extended:true}));
app.use(session({secret:process.env.SESSION_SECRET||"development-secret",resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:604800000}}));
app.use(express.static(path.join(__dirname,"public")));
const today=()=>new Date().toISOString().slice(0,10);
const auth=(req,res,next)=>req.session.user?next():res.status(401).json({error:"Bitte zuerst einloggen."});
const admin=(req,res,next)=>req.session.user?.role==="ADMIN"?next():res.status(403).json({error:"Admin-Bereich nicht erlaubt."});

// Registration and login.
app.post("/api/register",(req,res)=>{
 const {name,email,password}=req.body;if(!name||!email||!password||password.length<8)return res.status(400).json({error:"Name, E-Mail und Passwort (mind. 8 Zeichen) sind erforderlich."});
 try{const e=String(email).trim().toLowerCase(),r=db.prepare("INSERT INTO users(name,email,password_hash) VALUES(?,?,?)").run(String(name).trim(),e,bcrypt.hashSync(password,12));
 db.prepare("INSERT INTO profiles(user_id) VALUES(?)").run(r.lastInsertRowid);req.session.user={id:Number(r.lastInsertRowid),name:String(name).trim(),email:e,role:"USER"};res.status(201).json({user:req.session.user});
 }catch(x){if(String(x.message).includes("UNIQUE"))return res.status(409).json({error:"Diese E-Mail-Adresse ist bereits registriert."});res.status(500).json({error:"Registrierung fehlgeschlagen."})}
});
app.post("/api/login",(req,res)=>{
 const u=db.prepare("SELECT id,name,email,password_hash,role FROM users WHERE email=?").get(String(req.body.email||"").trim().toLowerCase());
 if(!u||!bcrypt.compareSync(req.body.password||"",u.password_hash))return res.status(401).json({error:"E-Mail oder Passwort ist falsch."});
 req.session.user={id:u.id,name:u.name,email:u.email,role:u.role};res.json({user:req.session.user});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/me",(req,res)=>res.json({user:req.session.user||null}));

// Profile.
app.get("/api/allergies",auth,(req,res)=>res.json(db.prepare("SELECT id,name FROM allergies ORDER BY name").all()));
app.get("/api/profile",auth,(req,res)=>res.json({
 profile:db.prepare("SELECT * FROM profiles WHERE user_id=?").get(req.session.user.id),
 allergies:db.prepare("SELECT a.id,a.name FROM allergies a JOIN user_allergies ua ON ua.allergy_id=a.id WHERE ua.user_id=? ORDER BY a.name").all(req.session.user.id)
}));
app.put("/api/profile",auth,(req,res)=>{
 const b=req.body,id=req.session.user.id;
 db.prepare("INSERT INTO profiles(user_id,weight,height,activity_level,diet_type,calorie_limit,fasting_model) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET weight=excluded.weight,height=excluded.height,activity_level=excluded.activity_level,diet_type=excluded.diet_type,calorie_limit=excluded.calorie_limit,fasting_model=excluded.fasting_model")
 .run(id,b.weight?Number(b.weight):null,b.height?Number(b.height):null,b.activityLevel||null,b.dietType||"normal",b.calorieLimit?Number(b.calorieLimit):null,b.fastingModel||"16:8");
 db.prepare("DELETE FROM user_allergies WHERE user_id=?").run(id);
 const add=db.prepare("INSERT OR IGNORE INTO user_allergies(user_id,allergy_id) VALUES(?,?)");
 (Array.isArray(b.allergyIds)?b.allergyIds:[]).map(Number).filter(Boolean).forEach(x=>add.run(id,x));res.json({ok:true});
});

// Dashboard, water, weight and feedback.
app.get("/api/dashboard",auth,(req,res)=>{
 const id=req.session.user.id,p=db.prepare("SELECT * FROM profiles WHERE user_id=?").get(id);
 res.json({profile:p,waterToday:db.prepare("SELECT COALESCE(SUM(amount_ml),0) n FROM water_entries WHERE user_id=? AND entry_date=?").get(id,today()).n,
 waterGoal:2000,recentWater:db.prepare("SELECT entry_date date,SUM(amount_ml) amount FROM water_entries WHERE user_id=? GROUP BY entry_date ORDER BY entry_date DESC LIMIT 7").all(id).reverse(),
 weights:db.prepare("SELECT entry_date date,weight FROM weight_entries WHERE user_id=? ORDER BY entry_date DESC LIMIT 14").all(id).reverse(),
 exercises:db.prepare("SELECT * FROM relaxation_exercises ORDER BY id").all(),fastingModel:p?.fasting_model||"16:8"});
});
app.post("/api/water",auth,(req,res)=>{const n=Number(req.body.amount);if(!Number.isFinite(n)||n<=0||n>10000)return res.status(400).json({error:"Ungültige Wassermenge."});db.prepare("INSERT INTO water_entries(user_id,amount_ml,entry_date) VALUES(?,?,?)").run(req.session.user.id,Math.round(n),today());res.json({ok:true})});
app.post("/api/weight",auth,(req,res)=>{const n=Number(req.body.weight);if(!Number.isFinite(n)||n<20||n>400)return res.status(400).json({error:"Ungültiges Gewicht."});db.prepare("INSERT INTO weight_entries(user_id,weight,entry_date) VALUES(?,?,?)").run(req.session.user.id,n,today());db.prepare("UPDATE profiles SET weight=? WHERE user_id=?").run(n,req.session.user.id);res.json({ok:true})});
app.post("/api/feedback",auth,(req,res)=>{const r=Number(req.body.rating),m=String(req.body.message||"").trim();if(r<1||r>5||m.length<3)return res.status(400).json({error:"Bitte Bewertung und Feedback ausfüllen."});db.prepare("INSERT INTO feedback(user_id,rating,message) VALUES(?,?,?)").run(req.session.user.id,r,m);res.status(201).json({ok:true})});

// Admin read-only MVP.
app.get("/api/admin/users",admin,(req,res)=>res.json(db.prepare("SELECT u.id,u.name,u.email,u.role,u.created_at,p.weight,p.height,p.diet_type,p.fasting_model,p.calorie_limit FROM users u LEFT JOIN profiles p ON p.user_id=u.id ORDER BY u.created_at DESC").all()));
app.get("/api/admin/feedback",admin,(req,res)=>res.json(db.prepare("SELECT f.*,COALESCE(u.name,'Gelöschter Benutzer') user_name FROM feedback f LEFT JOIN users u ON u.id=f.user_id ORDER BY f.created_at DESC").all()));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log("MyFastingDiet: http://localhost:"+PORT));