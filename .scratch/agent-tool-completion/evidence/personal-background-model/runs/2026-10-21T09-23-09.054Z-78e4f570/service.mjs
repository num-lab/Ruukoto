import * as http from "node:http";
import * as fs from "node:fs";
const server=http.createServer((_request,response)=>{response.writeHead(200,{"content-type":"text/html; charset=utf-8"});response.end("<!doctype html><html><head><title>PAGE_324fd6436f2b4b86b8f4e104c0ee4fbc</title></head><body><p>PAGE_324fd6436f2b4b86b8f4e104c0ee4fbc</p></body></html>");});
server.listen(0,"127.0.0.1",()=>{const url="http://127.0.0.1:"+server.address().port;fs.writeFileSync("service-runtime.json",JSON.stringify({pid:process.pid,url})+"\n",{mode:0o600});process.stdout.write("READY "+url+"\nSTDOUT_748e2c73a90e463db26e1f4bc3bda8a3\n");process.stderr.write("STDERR_e65cd34141164497b411832fb8d7b369\n");});
setTimeout(()=>server.close(()=>process.exit(0)),600000).unref();
