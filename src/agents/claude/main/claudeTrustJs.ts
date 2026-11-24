const CLAUDE_TRUST_JS = [
  'const fs=require("fs"),path=require("path");',
  'const [f,d]=process.argv.slice(1);',
  'let top=null;',
  'for(let x=d;;x=path.dirname(x)){',
  'let s;try{s=fs.lstatSync(path.join(x,".git"))}catch(e){}',
  'if(s&&(s.isDirectory()||s.isFile())){top=x;if(s.isFile())try{',
  'const l=fs.readFileSync(path.join(x,".git"),"utf8").split("\\n").find((l)=>l.startsWith("gitdir:"));',
  'const g=path.resolve(x,l.slice(7).trim());',
  'top=path.dirname(path.resolve(g,fs.readFileSync(path.join(g,"commondir"),"utf8").trim()));',
  'try{top=fs.realpathSync(top)}catch(e){}',
  '}catch(e){top=x}break}',
  'if(path.dirname(x)===x)break}',
  'const trusted=(p)=>{',
  'const ok=(x)=>p[x]&&p[x].hasTrustDialogAccepted===true;',
  'if(top!==null&&d!==top&&!d.startsWith(top.endsWith("/")?top:top+"/"))return ok(d);',
  'for(let x=d;;x=path.dirname(x)){',
  'if(ok(x))return true;',
  'if(x===top||path.dirname(x)===x)return false}};'
].join('')

export const TRUST_CWD_JS = [
  CLAUDE_TRUST_JS,
  'let j={};',
  'try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){if(e.code!=="ENOENT")process.exit(0)}',
  'const p=(j.projects=j.projects||{});',
  'if(trusted(p))process.exit(0);',
  'p[d]=Object.assign({},p[d],{hasTrustDialogAccepted:true});',
  'fs.writeFileSync(f+".koloft",JSON.stringify(j,null,2),{mode:0o600});',
  'fs.renameSync(f+".koloft",f)'
].join('')

export const TRUSTED_JS = [
  CLAUDE_TRUST_JS,
  'let p={};',
  'try{p=JSON.parse(fs.readFileSync(f,"utf8")).projects||{}}catch(e){}',
  'process.exit(trusted(p)?0:1)'
].join('')
