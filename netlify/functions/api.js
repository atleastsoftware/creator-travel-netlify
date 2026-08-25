const express = require("express");
const serverless = require("serverless-http");
const crypto = require("crypto");
const Stripe = require("stripe");

const app = express();

const STORE = {
  properties: "creator-properties",
  bookings: "creator-bookings",
  clicks: "creator-airbnb-clicks"
};

let blobsPromise;
async function blobs() {
  if (!blobsPromise) blobsPromise = import("@netlify/blobs");
  return blobsPromise;
}
async function store(name) {
  const { getStore } = await blobs();
  return getStore({ name, consistency: "strong" });
}

const stripe = process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes("REPLACE_ME")
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

function json(res, status, body) { return res.status(status).json(body); }
function slugify(input) {
  return String(input || "")
    .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || `property-${Date.now()}`;
}
function tokenSign(payload) {
  const secret = process.env.SESSION_SECRET || "dev-secret-change-me";
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}
function tokenVerify(token) {
  try {
    const [data, sig] = String(token || "").split(".");
    if (!data || !sig) return null;
    const secret = process.env.SESSION_SECRET || "dev-secret-change-me";
    const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function safeEqual(a,b){
  const A=Buffer.from(String(a||"")), B=Buffer.from(String(b||""));
  if(A.length!==B.length) return false;
  return crypto.timingSafeEqual(A,B);
}
function auth(req,res,next){
  const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i,"");
  const user=tokenVerify(t);
  if(!user) return json(res,401,{error:"Unauthorized"});
  req.user=user; next();
}
function admin(req,res,next){
  if(req.user?.role!=="admin") return json(res,403,{error:"Admin required"});
  next();
}
function nightsBetween(a,b){
  const x=new Date(`${a}T00:00:00Z`), y=new Date(`${b}T00:00:00Z`);
  if(Number.isNaN(x.valueOf())||Number.isNaN(y.valueOf())) return 0;
  return Math.round((y-x)/86400000);
}
async function listJSON(storeName){
  const s=await store(storeName);
  const { blobs }=await s.list();
  const out=[];
  for(const item of blobs){
    const row=await s.get(item.key,{type:"json",consistency:"strong"});
    if(row) out.push(row);
  }
  return out;
}
async function getJSON(storeName,key){
  return (await store(storeName)).get(String(key),{type:"json",consistency:"strong"});
}
async function setJSON(storeName,key,value){
  return (await store(storeName)).setJSON(String(key),value);
}
async function ensureDemo(){
  const s=await store(STORE.properties);
  const { blobs: items }=await s.list();
  if(items.length) return;
  const p={
    id: crypto.randomUUID(),
    slug:"demo-villa",
    title:"Demo Pool Villa",
    location:"Krabi",
    country:"Thailand",
    description:"A sample stay to demonstrate the creator storefront. Replace this property from the dashboard.",
    image_url:"https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?auto=format&fit=crop&w=1600&q=80",
    airbnb_url:"https://www.airbnb.com/",
    allow_direct:true,
    currency:"EUR",
    nightly_price_cents:18000,
    cleaning_fee_cents:3000,
    min_nights:2,
    commission_percent:Number(process.env.DEFAULT_COMMISSION_PERCENT||10),
    published:true,
    created_at:new Date().toISOString(),
    updated_at:new Date().toISOString()
  };
  await s.setJSON(p.id,p,{onlyIfNew:true});
}

app.get("/config",(req,res)=>{
  res.json({
    storeName:process.env.STORE_NAME||"Travel With Creator",
    creatorName:process.env.CREATOR_NAME||"Creator",
    creatorHandle:process.env.CREATOR_HANDLE||"@creator",
    heroTitle:"Stay where I stayed.",
    heroSubtitle:"My hand-picked villas, apartments and hotels. Book on Airbnb or directly when available.",
    tagline:"The places I actually stayed — book the same experience.",
    defaultCommissionPercent:Number(process.env.DEFAULT_COMMISSION_PERCENT||10)
  });
});

app.post("/stripe/webhook", express.raw({type:"application/json"}), async (req,res)=>{
  if(!stripe || !process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET.includes("REPLACE_ME")){
    return res.status(503).send("Stripe webhook not configured");
  }
  let event;
  try{
    event=stripe.webhooks.constructEvent(req.body,req.headers["stripe-signature"],process.env.STRIPE_WEBHOOK_SECRET);
  }catch(e){ return res.status(400).send(`Webhook Error: ${e.message}`); }

  const obj=event.data.object;
  if(["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(event.type)){
    const bookingId=obj.metadata?.booking_id;
    if(bookingId){
      const b=await getJSON(STORE.bookings,bookingId);
      if(b){
        b.payment_status=(obj.payment_status==="paid"||event.type==="checkout.session.async_payment_succeeded")?"paid":b.payment_status;
        b.stripe_payment_intent_id=String(obj.payment_intent||"");
        b.updated_at=new Date().toISOString();
        await setJSON(STORE.bookings,b.id,b);
      }
    }
  }
  if(["checkout.session.async_payment_failed","checkout.session.expired"].includes(event.type)){
    const bookingId=obj.metadata?.booking_id;
    if(bookingId){
      const b=await getJSON(STORE.bookings,bookingId);
      if(b){b.payment_status="failed";b.updated_at=new Date().toISOString();await setJSON(STORE.bookings,b.id,b);}
    }
  }
  res.json({received:true});
});

app.use(express.json({limit:"1mb"}));

app.post("/login",(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  let role=null;
  if(email===String(process.env.ADMIN_EMAIL||"admin@example.com").toLowerCase() && safeEqual(password,process.env.ADMIN_PASSWORD||"replace-me")) role="admin";
  else if(email===String(process.env.CREATOR_EMAIL||"creator@example.com").toLowerCase() && safeEqual(password,process.env.CREATOR_PASSWORD||"replace-me")) role="creator";
  if(!role) return json(res,401,{error:"Invalid email or password"});
  const user={email,role,exp:Date.now()+7*24*60*60*1000};
  res.json({token:tokenSign(user),user:{email,role}});
});
app.get("/me",auth,(req,res)=>res.json({user:{email:req.user.email,role:req.user.role}}));

app.get("/properties",async(req,res)=>{
  await ensureDemo();
  const rows=(await listJSON(STORE.properties)).filter(p=>p.published).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
  res.json(rows);
});
app.get("/properties/:slug",async(req,res)=>{
  await ensureDemo();
  const rows=await listJSON(STORE.properties);
  const p=rows.find(x=>x.slug===req.params.slug && x.published);
  if(!p) return json(res,404,{error:"Property not found"});
  res.json(p);
});

app.get("/dashboard/properties",auth,async(req,res)=>{
  await ensureDemo();
  const rows=(await listJSON(STORE.properties)).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
  res.json(rows);
});
app.post("/dashboard/properties",auth,async(req,res)=>{
  const title=String(req.body.title||"").trim();
  if(!title) return json(res,400,{error:"Title is required"});
  const all=await listJSON(STORE.properties);
  let slug=slugify(req.body.slug||title), n=2;
  while(all.some(p=>p.slug===slug)) slug=`${slugify(req.body.slug||title)}-${n++}`;
  const p={
    id:crypto.randomUUID(),slug,title,
    location:String(req.body.location||"").trim(),
    country:String(req.body.country||"").trim(),
    description:String(req.body.description||"").trim(),
    image_url:String(req.body.image_url||"").trim(),
    airbnb_url:String(req.body.airbnb_url||"").trim(),
    allow_direct:Boolean(req.body.allow_direct),
    currency:String(req.body.currency||"EUR").toUpperCase().slice(0,3),
    nightly_price_cents:Math.max(0,Math.round(Number(req.body.nightly_price||0)*100)),
    cleaning_fee_cents:Math.max(0,Math.round(Number(req.body.cleaning_fee||0)*100)),
    min_nights:Math.max(1,Math.round(Number(req.body.min_nights||1))),
    commission_percent:Math.min(100,Math.max(0,Number(req.body.commission_percent??process.env.DEFAULT_COMMISSION_PERCENT??10))),
    published:req.body.published!==false,
    created_at:new Date().toISOString(),updated_at:new Date().toISOString()
  };
  await setJSON(STORE.properties,p.id,p); res.json(p);
});
app.put("/dashboard/properties/:id",auth,async(req,res)=>{
  const p=await getJSON(STORE.properties,req.params.id);
  if(!p) return json(res,404,{error:"Property not found"});
  const next={...p,
    title:String(req.body.title??p.title).trim(),
    location:String(req.body.location??p.location).trim(),
    country:String(req.body.country??p.country).trim(),
    description:String(req.body.description??p.description).trim(),
    image_url:String(req.body.image_url??p.image_url).trim(),
    airbnb_url:String(req.body.airbnb_url??p.airbnb_url).trim(),
    allow_direct:req.body.allow_direct===undefined?p.allow_direct:Boolean(req.body.allow_direct),
    currency:String(req.body.currency??p.currency).toUpperCase().slice(0,3),
    nightly_price_cents:req.body.nightly_price===undefined?p.nightly_price_cents:Math.max(0,Math.round(Number(req.body.nightly_price)*100)),
    cleaning_fee_cents:req.body.cleaning_fee===undefined?p.cleaning_fee_cents:Math.max(0,Math.round(Number(req.body.cleaning_fee)*100)),
    min_nights:req.body.min_nights===undefined?p.min_nights:Math.max(1,Math.round(Number(req.body.min_nights))),
    commission_percent:req.body.commission_percent===undefined?p.commission_percent:Math.min(100,Math.max(0,Number(req.body.commission_percent))),
    published:req.body.published===undefined?p.published:Boolean(req.body.published),
    updated_at:new Date().toISOString()
  };
  await setJSON(STORE.properties,next.id,next); res.json(next);
});
app.delete("/dashboard/properties/:id",auth,admin,async(req,res)=>{
  const bookings=await listJSON(STORE.bookings);
  if(bookings.some(b=>b.property_id===req.params.id)) return json(res,409,{error:"This property has bookings. Unpublish it instead."});
  (await store(STORE.properties)).delete(req.params.id); res.json({ok:true});
});

app.post("/referral",(req,res)=>{
  res.json({ok:true,ref:String(req.body.ref||"").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,60)});
});

app.get("/go/airbnb/:propertyId",async(req,res)=>{
  const p=await getJSON(STORE.properties,req.params.propertyId);
  if(!p||!p.published||!p.airbnb_url) return res.status(404).send("Airbnb link not available");
  let u; try{u=new URL(p.airbnb_url); if(!["https:","http:"].includes(u.protocol)) throw new Error();}catch{return res.status(400).send("Invalid Airbnb link")}
  const click={id:crypto.randomUUID(),property_id:p.id,property_title:p.title,referral_code:String(req.query.ref||"").slice(0,100),created_at:new Date().toISOString()};
  await setJSON(STORE.clicks,click.id,click); res.redirect(u.toString());
});

app.post("/checkout",async(req,res)=>{
  if(!stripe) return json(res,503,{error:"Stripe is not configured yet."});
  const p=await getJSON(STORE.properties,req.body.propertyId);
  if(!p||!p.published||!p.allow_direct) return json(res,404,{error:"Direct booking unavailable."});
  const checkIn=String(req.body.checkIn||""),checkOut=String(req.body.checkOut||"");
  const nights=nightsBetween(checkIn,checkOut);
  const guests=Math.max(1,Math.min(30,Math.round(Number(req.body.guests||1))));
  const guest_name=String(req.body.guestName||"").trim().slice(0,120);
  const guest_email=String(req.body.guestEmail||"").trim().toLowerCase().slice(0,200);
  const guest_phone=String(req.body.guestPhone||"").trim().slice(0,80);
  if(nights<p.min_nights) return json(res,400,{error:`Minimum stay is ${p.min_nights} night(s).`});
  if(!guest_name||!guest_email.includes("@")) return json(res,400,{error:"Valid name and email are required."});

  const bookings=await listJSON(STORE.bookings);
  const conflict=bookings.some(b=>b.property_id===p.id && ["pending","paid"].includes(b.payment_status) && !(b.check_out<=checkIn || b.check_in>=checkOut));
  if(conflict) return json(res,409,{error:"Those dates are no longer available."});

  const subtotal=p.nightly_price_cents*nights,total=subtotal+p.cleaning_fee_cents;
  const id=crypto.randomUUID(), commission=Math.round(total*(p.commission_percent/100));
  const booking={
    id,public_id:id,property_id:p.id,property_title:p.title,property_slug:p.slug,
    check_in:checkIn,check_out:checkOut,nights,guests,guest_name,guest_email,guest_phone,
    referral_code:String(req.body.referralCode||"").slice(0,100),
    subtotal_cents:subtotal,cleaning_fee_cents:p.cleaning_fee_cents,total_cents:total,
    currency:p.currency,commission_percent:p.commission_percent,commission_cents:commission,
    payment_status:"pending",stripe_session_id:"",stripe_payment_intent_id:"",
    created_at:new Date().toISOString(),updated_at:new Date().toISOString()
  };
  await setJSON(STORE.bookings,id,booking);

  const origin=req.headers.origin || `https://${req.headers.host}`;
  try{
    const s=await stripe.checkout.sessions.create({
      mode:"payment",
      customer_email:guest_email,
      success_url:`${origin}/success.html?booking=${encodeURIComponent(id)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:`${origin}/property.html?slug=${encodeURIComponent(p.slug)}&cancelled=1`,
      metadata:{booking_id:id,property_id:p.id,referral_code:booking.referral_code},
      line_items:[{quantity:1,price_data:{currency:p.currency.toLowerCase(),unit_amount:total,product_data:{name:`${p.title} — ${nights} night${nights>1?"s":""}`,description:`${checkIn} → ${checkOut} • ${guests} guest${guests>1?"s":""}`}}}]
    });
    booking.stripe_session_id=s.id; booking.updated_at=new Date().toISOString();
    await setJSON(STORE.bookings,id,booking);
    res.json({url:s.url});
  }catch(e){
    booking.payment_status="failed";booking.updated_at=new Date().toISOString();await setJSON(STORE.bookings,id,booking);
    json(res,500,{error:"Unable to create Stripe Checkout.",detail:e.message});
  }
});

app.get("/bookings/:publicId",async(req,res)=>{
  const b=await getJSON(STORE.bookings,req.params.publicId);
  if(!b) return json(res,404,{error:"Booking not found"});
  res.json({
    public_id:b.public_id,property_title:b.property_title,property_slug:b.property_slug,
    check_in:b.check_in,check_out:b.check_out,nights:b.nights,guests:b.guests,total_cents:b.total_cents,
    currency:b.currency,payment_status:b.payment_status
  });
});

app.get("/dashboard/stats",auth,async(req,res)=>{
  const [bookings,clicks]=await Promise.all([listJSON(STORE.bookings),listJSON(STORE.clicks)]);
  const paid=bookings.filter(b=>b.payment_status==="paid");
  res.json({
    booking_count:paid.length,
    paid_revenue_cents:paid.reduce((a,b)=>a+Number(b.total_cents||0),0),
    paid_commission_cents:paid.reduce((a,b)=>a+Number(b.commission_cents||0),0),
    airbnb_clicks:clicks.length,
    recent:bookings.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,100)
  });
});

module.exports.handler = serverless(app);
