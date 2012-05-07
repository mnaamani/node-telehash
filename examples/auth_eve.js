var channels = require('channels');
var securelink = require('./secure-link');

channels.init({   
    ready: function () {   	
        connect();
    }
});

var LINK = {
    self:{
        id:"@bob",                  //eve is pretending to be @bob
        key:"keys/alice.pri.pem"    //clearly this is not @bob's private key!
    },
    peers:{},
    callback:onConnected
}

LINK.peers["@bob"]={key:"keys/bob.pub.pem"};
LINK.peers["@alice"]={key:"keys/alice.pub.pem"};

function connect() {
    channels.listen(LINK.self.id, function(peer){
        securelink.incoming(LINK,peer);
    });
}


function onConnected( obj ){
    if(obj.error) {console.log(obj.error); return;}
    //eve will not reach here because anyone she negotiates with will not
    //send the final signature..
    
    //if we reached here we have a secure link
    obj.link.send(new Buffer("Hi "+obj.link.peerid+", I'm "+LINK.self.id+"!"));
    obj.link.data=function( msg ){
        console.log( "<<secure message>>",msg.toString() );
    }  
}