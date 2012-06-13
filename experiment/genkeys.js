var otr=require("otr");
console.log("libotr version:",otr.version());

var users = {
    alice: new otr.User(),
    bob: new otr.User(),
    eve: new otr.User()
};

users.alice.conf ={
    keys: "./keys/alice.keys",
    fingerprints: "./keys/alice.fp",
    account: "alice@telechat.org",
    proto: "telechat"   
};

users.bob.conf={
    keys: "./keys/bob.keys",
    fingerprints: "./keys/bob.fp",
    account: "bob@telechat.org",
    proto: "telechat"    
};

//malicious user
users.eve.conf={
    keys: "./keys/eve.keys",
    fingerprints: "./keys/eve.fp",
    account: "alice@telechat.org",
    proto: "telechat"
};

function genKey(user,cb){
    var conf = user.conf;
    console.log("Generating OTR key for:", conf.proto+":"+conf.account);
    user.generateKey(conf.keys,conf.account,conf.proto,function(err){        
	    if(!err){
	     console.log("Key Generated. for:",conf.proto+":"+conf.account);	     
	    }else{
	     console.log(err);
	    }
        if(cb) cb(user);
    });
}

genKey(users.eve);

/*
genKey(users.alice, function(){
	genKey(users.bob);
});
*/