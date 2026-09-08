function ARRefresh({onClick,busy=false,title='Refresh','aria-label':ariaLabel}){
 const [pending,setPending]=k.useState(false),flight=k.useRef(false),{say}=Ne();
 const loading=busy||pending;
 async function refresh(event){if(busy||flight.current)return;flight.current=true;setPending(true);try{await onClick(event)}catch{say('Could not refresh. Please try again.')}finally{flight.current=false;setPending(false)}}
 return r.jsxs('button',{type:'button',className:'btn ar-refresh',disabled:loading,onClick:refresh,title,'aria-label':ariaLabel||title,'aria-busy':loading,style:{height:30,fontSize:11.5,padding:'0 10px',gap:6,flexShrink:0},children:[r.jsx('i',{className:`ph ${loading?'ph-circle-notch':'ph-arrows-clockwise'}`,'aria-hidden':true,style:{fontSize:13}}),loading?'Refreshing…':'Refresh']});
}
