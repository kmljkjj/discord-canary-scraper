self.addEventListener("message",async e=>{let{data:{url:a}}=e,s=!1;try{await fetch(a)}catch(e){s=!0}self.postMessage({url:a,error:s})});
//# sourceMappingURL=4846a37bc2e8e4d8.js.map