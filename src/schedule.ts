// Phase workers on the same shared provider queue; stop cancels startup and repeats.
export function schedule(task:()=>void, intervalMs:number, initialDelayMs=0):()=>void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const initial=setTimeout(()=>{ task(); timer=setInterval(task,intervalMs); },initialDelayMs);
  return ()=>{clearTimeout(initial);if(timer)clearInterval(timer);};
}
