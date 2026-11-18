// No timers or network work here; the server owns one non-overlapping poll job.
export class CommentSchedule {
  constructor(){this.nextAt=0;this.idle=0;this.failures=0;this.revision=null;}
  due(now,revision){if(revision!==this.revision){this.revision=revision;this.nextAt=0;this.idle=0;this.failures=0;}return now>=this.nextAt;}
  complete(now,result,failed=false){
    this.failures=failed?this.failures+1:0;
    this.idle=result?.newComments?0:this.idle+1;
    const minutes=failed?Math.min(30,2**Math.min(this.failures,5)):Math.min(15,2**Math.min(this.idle+1,4));
    this.nextAt=now+minutes*60000;
    return {checkedAt:now,nextAt:this.nextAt,intervalMinutes:minutes,newComments:result?.newComments||0,replied:result?.replied||0};
  }
}
