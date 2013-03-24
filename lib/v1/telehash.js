var udplib = require('../udplib');
var slib = require('./switch');
var hlib = require('./hash');
var util = require('../iputil');

// high level exported functions
// init({port:42424, seeds:['1.2.3.4:5678], handleOOB:function(data){},mode:(1|2|3) })
// use it to pass in custom settings other than defaults, optional but if used must be called first!
exports.init = getSelf;

// seed(function(err){}) - will start seeding to dht, calls back w/ error/timeout or after first contact
exports.seed = doSeed;

// before using listen and connect, should seed() first for best karma!

// listen('id', function(switch, telex){}) - give an id to listen to on the dHT, callback fires whenever incoming messages (requests) arrive to it.
// essentially this gives us a way to announce ourselves on the DHT by a sha1 hash of given id. 
// think of the id like a dns hostname,url,email address,mobile number...etc.
exports.listen = doListen;

// connect('id') - id to connect to. Will return a 'connector' object used to send messages (requests), and handle responses
exports.connect = doConnect;

// send('ip:port', {...}) - sends the given telex to the target ip:port
// will attempt to find it and punch through any NATs, etc, but is lossy, no guarantees/confirmations
// it's best to use this function rather than the Switch.prototype.send().
exports.send = doSend;


exports.tap = doTap;
exports.dial = doDial;
exports.announce = doAnnounce;
exports.ping = doPing;

// as expected
exports.shutdown = doShutdown;

// internals
var self;
var listeners = [];         //maintain an array of .tap rules we are interested in
var connectors = {};        //maintains a hashtable of ends we are interested in contacting indexed by a end name.
var responseHandlers = {};  //maintains a hashtable of response handlers indexed by connection 'guid'

/*
   STATE.OFFLINE: initial state
   STATE.SEEDING: only handle packets from seeds to determine our ip:port and NAT type
   STATE.ONLINE full packet processing
   TODO:add callbacks to inform user of the module when switching between states..
*/
var STATE = {
    offline: 0,
    seeding: 1,
    online: 2
};

/* 
Switch Operating Modes..
    Announcer:  Only dials and sends signals, doesn't process any commands other than .see and
                doesn't send any _ring, possibly short-lived.                
    Listener:   Stays running, also supports returning basic _ring/_line/_br so that it can
                send .tap commands in order to receive new signals, but processes no other commands.                
    Full:       Supports all commands and relaying to any active .tap (must not be behind SNAT)
                Full Switches need to implement seeding, keeping lines open, a basic bucketing system
                that tracks active Switches at different distances from themselves. A Full Switch needs
                to do basic duplicate detection, it should only process a unique set of signals at
                most once every 10 seconds (hash the sorted string sigs/values).
*/
var MODE = {
    FULL:3,
    LISTENER: 2,
    ANNOUNCER:1
};

// init self, use this whenever it may not be init'd yet to be safe
function getSelf(arg) {
    if (self) return self;
    self = arg || {};

    if(!self.mode) self.mode = MODE.LISTENER; //default operating mode
    
    self.state = STATE.offline; //start in offline state
    if (!self.seeds) self.seeds = ['208.68.164.253:42424', '208.68.163.247:42424'];

    //detect local interfaces    
    var localifs = util.getLocalIP();
    if(!localifs.length){
        self.nat = true;    //if this is windows and we cannot detect interfaces, force NAT
    }
    // udp socket - If bind port is not specified, pick a random open port.
    self.server = udplib.createSocket(self.udplib? self.udplib:"enet", incomingDgram, self.port ? parseInt(self.port) : 0, self.ip || '0.0.0.0');

    // set up switch master callbacks
    var callbacks = {
        sock:    self.server,
        nat:     function(){ return (self.nat==true || self.snat==true) },
        snat:    function(){ return (self.snat==true) },
        news:    doNews,
        data:    doSignals,
        signals: doSignals,
        mode:   function(){ return self.mode }        
    };
    
    //disable tapping, master signal handlers and limit connect/listen functions with warnings.
    if(self.mode == MODE.ANNOUNCER){
        callbacks.data = callbacks.signals = function(){};
        exports.tap = function(){
            //console.error("WARNING: Tapping not supported in Announcer Mode.");
        };
        exports.connect = function(end_name){
            //console.error("WARNING: No Responses will be received in Announcer Mode");
            return doConnect(end_name, true);
        };
        exports.listen = function(){
            //console.error("WARNING: Listen feature not supported in Announcer Mode.");
        };
    }
    
    slib.setCallbacks(callbacks);

    // start timer to monitor all switches and drop any over thresholds and not in buckets
    self.scanTimeout = setInterval(scan, 25000); // every 25sec, so that it runs 2x in <60 (if behind a NAT to keep mappings alive)
    
    // start timer to send out .taps and dial switches closer to the ends we want to .tap
    self.connect_listen_Interval = setInterval(connect_listen, 5000);

    return self;
}

function resetIdentity() {
    if (self.me) {
        self.me.drop();
    }
    delete self.me;
    listeners = [];
    connectors = {};
    delete self.nat;
    delete self.snat;
}

function doSeed(callback) {
    //make sure we are initialised
    getSelf();

    //we can only seed into DHT when we are offline.
    if (self.state != STATE.offline) {
        return;
    }
    //reset our identity
    resetIdentity();

    console.error("seeding...");
    self.state = STATE.seeding;

    if (callback) self.onSeeded = callback;

    // in 10 seconds, error out if nothing yet!
    self.seedTimeout = setTimeout(function () {
        self.state = STATE.offline; //go back into offline state
        if (self.onSeeded) self.onSeeded("timeout");
        delete self.seedTimeout;
        purgeSeeds();
        //try again...
        doSeed(callback);
    }, 10000);

    pingSeeds();
}

function purgeSeeds() {
    self.seeds.forEach(function (ipp) {
        slib.getSwitch(ipp).drop();
    });
}

function pingSeeds() {
    // loop all seeds, asking for furthest end from them to get the most diverse responses!
    self.seeds.forEach(function (ipp) {
        var hash = new hlib.Hash(ipp);
        var s = slib.getSwitch(ipp);
        s.seed = true; //mark it as a seed - (during scan check if we have lines open to any initial seeds)
        s.visible = true;
        s.popped = true;
        s.send({
            '+end': hash.far()
        });
    });
}

//filter incoming packets based on STATE
function incomingDgram(msg, rinfo) {

    if (self.state == STATE.offline) {
        //drop all packets
        return;
    }
    //who is it from?
    var from = rinfo.address + ":" + rinfo.port;

    //parse the packet..and handle out-of-band packets..
    try {
        var telex = JSON.parse(msg.toString());

    } catch (E) {
        return;
    }

    //at this point we should have a telex for processing
    //console.error("<--\t" + from + "\t" + msg.toString());

    if (self.state == STATE.seeding) {
        //only accept packets from seeds - note: we need at least 2 live seeds for SNAT detection
        for (var i in self.seeds) {
            if (from == self.seeds[i]) {
                handleSeedTelex(telex, from, msg.length);
                break;
            }
        }
        return;
    }
    if (self.state == STATE.online) {
        //process all packets
        handleTelex(telex, from, msg.length);
    }
}

function handleSeedTelex(telex, from, len) {

    //do NAT detection once
    if(!self.nat){
        if (!self.me && telex._to && !util.isLocalIP(telex._to)) {
            //we are behind NAT
            self.nat = true;
            //console.error("NAT detected.");
        }
    }
    
    //first telex from seed will establish our identity
    if (!self.me && telex._to) {
        self.me = slib.getSwitch(telex._to);
        self.me.self = true; // flag switch to not send to itself
        clearTimeout(self.seedTimeout);
        delete self.seedTimeout;
        console.error("our ipp:",self.me.ipp,self.me.end);
        //delay...to allow time for SNAT detection (we need a response from another seed)
        setTimeout(function () {
            if (!self.snat && self.mode == MODE.FULL){
                 self.me.visible = true; //become visible (announce our-selves in .see commands)
                 //console.error('Making ourself Visible..');
            }
            self.state = STATE.online;
            console.error("going online","nat:",self.nat,"snat:",self.snat, "visible:", self.me.visible,"mode:", self.mode);
            if(self.nat) doPopTap(); //only needed if we are behind NAT
            if (self.onSeeded) self.onSeeded();
        }, 2000);
    }

    if (self.me && from == self.me.ipp) {
        console.error("self seeding.");
        self.seed = true;
    }

    if (telex._to && self.me && !self.snat && (util.IP(telex._to) == self.me.ip) && (self.me.ipp !== telex._to)) {
        //we are behind symmetric NAT
        //console.error("symmetric NAT detected.");
        self.snat = true;
        self.nat = true;
        self.me.visible = false; //hard to be seen behind an SNAT :(
        if(self.mode == MODE.FULL){
            self.mode = MODE.LISTENER;//drop functionality to LISTENER
        }
    }

    //mark seed as visible
    slib.getSwitch(from).visible = true;
    handleTelex(telex, from, len); //handle the .see from the seed - establish line
}

function handleTelex(telex, from, len) {
    if (self.me && from == self.me.ipp) return; //dont process packets that claim to be from us! (we could be our own seed)

    if (telex._to) {
        if (self.snat) {
            //_to will not match self.me.ipp because we are behind SNAT but at least ip should match
            if (self.me.ip != util.IP(telex._to)) return;
        } else {
            //_to must equal our ipp
            if (self.me.ipp != telex._to) return;
        }

    } else {

        return; //bad telex? - review the spec ....
    }
    
    /*  
        depending on the level of implementation (operation mode) of remote switch it is acceptable
        not to have a _ring,_line,_to header..  
    */    
    //if there is a _line in the telex we should already know them..
    if (telex._line) {
        if (!slib.knownSwitch(from)) return;
    } else {
        //if (!telex._ring) return;
    }

    slib.getSwitch(from).process(telex, len);
}

// process a validated telex that has signals,data and commands to be handled
// these would be signals we have .tap'ed for
function doSignals(from, telex) {
    //ignore .tap and .see (already handeled)
    if(telex['.tap'] || telex['.see']) return;
    
    if( handleConnectResponses(from,telex) ) return;//intercept +response signals
    if( handleConnects(from,telex)) return;//intercept +connect signals
    
    //look for listener .tapping signals in this telex and callback it's handler
    listeners.forEach(function (listener) {
        if( slib.ruleMatch(telex, listener.rule) && listener.cb ) listener.cb(from,telex);
    }); 
}

function timeoutResponseHandlers(){
    for (var guid in responseHandlers){
        if( Date.now() > responseHandlers[guid].timeout ) {
            if(responseHandlers[guid].callback) responseHandlers[guid].callback(undefined);//always callback after timeout..
            delete responseHandlers[guid];
        }
    }
}

function handleConnects(from,telex){
    //return an object containing the message and a function to send reply
    //the reply function will send via relay if direct is not possible
    //indicate in object which type of reply will occur!
    if(!telex['+connect']) return false;
    
    listeners.forEach(function (listener) {

        if( slib.ruleMatch(telex, listener.rule) && listener.cb ) {
            listener.cb({
                guid:telex['+connect'],
                message:telex['+message'],
                from:telex['+from'],
                source:from.ipp,                
                // always return via relay signals..
                reply:function(message){
                    if(!telex['+from']) return;//if they didn't send us their end we can't reply
                    from.send({
                        '+end': telex['+from'],
                        '+message': message,
                        '+response': telex['+connect'],
                        '_hop':1
                    });
                },
                send:function(ipp,message){
                    doSend(ipp, {
                        '+message': message,
                        '+response': telex['+connect']
                    }); //direct telex
                }
            });
        }
    }); 
    return true;
}
function handleConnectResponses(from,telex){

    if (telex['+response']) {
        //this would be a telex +reponse to our outgoing +connect (could be direct or relayed)
        for (var guid in responseHandlers) {
            if (guid == telex['+response'] && responseHandlers[guid].callback ) {
                responseHandlers[guid].responses++;
                responseHandlers[guid].callback({from:from.ipp, message:telex['+message'], count:responseHandlers[guid].responses});
                return true;
            }
        }
        return true;
    }
    return false;
}

function sendPOPRequest(ipp) {
    slib.getSwitch(ipp).popped = true;
    if (self.snat) return; //pointless
    doAnnounce(ipp,{'+pop': 'th:' + self.me.ipp});
}

function doNews(s) {
    //new .seen switch    
    if(self && self.me){
      //console.error("Pinging New switch: ",s.ipp);
      if(s.via){
        s.popped = true;
        doSend(s.via,{
            '+end': s.end,
            '+pop':'th:'+self.me.ipp,
            '_hop':1
        });           
      }
      
      doPing(s.ipp);//will pop if required..              
    }
    
    // TODO if we're actively listening, and this is closest yet, ask it immediately
}

function doPopTap() {
    if( self.mode == MODE.ANNOUNCER) return;
    
    if (self.nat && !self.snat) {
        //console.error("Tapping +POPs...");
        listeners.push({
            hash: self.me.hash,
            end: self.me.end,
            rule: {
                'is': {
                    '+end': self.me.end
                },
                'has': ['+pop']
            }
        });
        //sendTapRequests(true);        
    }
}

function listenForResponse(arg, callback) {
    if(self.mode == MODE.ANNOUNCER) return;
    var end = new hlib.Hash(arg.id); //end we are tapping for
    var hash = new hlib.Hash(arg.connect); //where we will .tap
    var rule = {
        'is': {
            '+end': end.toString()
        },
        'has': ['+response']
    };
    var listener = {
        id: arg.id,
        hash: hash,
        end: end.toString(),
        rule: rule,
        cb: callback,
        far: true
    };
    listeners.push(listener);
    //listenLoop();//kick start far listeners to get our responses from first time.
    return listener;
}

// setup a listener for the hash of arg.id
// we want to receive telexe which have a +connect signal in them.
function doListen(id, callback) {
    if (!self.me) return;
    if (self.mode == MODE.ANNOUNCER ) return;
    //add a listener for arg.id 
    var hash = new hlib.Hash(id);
    var rule = {
        'is': {
            '+end': hash.toString()
        },
        'has': ['+connect']
    };
    
    doTap(id, rule, callback);
}

function listenLoop() {
    if (self && self.state != STATE.online) return;
    if (self.mode == MODE.ANNOUNCER) return;
    
    var count = 0;
    //look for closer switches
    listeners.forEach(function (listener) {
        count++;
        //console.error(count + ":LISTENER:" + JSON.stringify(listener.rule));
        
        slib.getNear(listener.hash).forEach(function (ipp) {
            doSend(ipp, {
                '+end': listener.end
            });
        });
        
        //doDial( listener.id ); //<<--not using this so we can support the listenforrespone.. where listener.end != listener.hash
    });
    sendTapRequests();
}

//TODO: from telehash.org/proto.html, under section common patterns:.. then send a .tap of which Signals to observe to those Switches close to the End along with some test Signals, who if willing will respond with process the .tap and immediately send the matching Signals back to confirm that it's active.
function sendTapRequests( noRateLimit ) {
//TODO make sure to only .tap visible switches..
    var limit = noRateLimit ? false : true;
    var tapRequests = {}; //hash of .tap arrays indexed by switch.ipp 
    //loop through all listeners and aggregate the .tap rules for each switch
    listeners.forEach(function (listener) {
        var switches = slib.getNear(listener.hash);
        switches.forEach(function (s) {
            if (!tapRequests[s]) tapRequests[s] = [];
            tapRequests[s].push(listener.rule);
        });
    });
    
    Object.keys(tapRequests).forEach(function (ipp) {
        var s = slib.getSwitch(ipp);
        if (!s.line) return; //only send out the .tap request if we have a line open
        //don't send .tap too often.. need to allow time to get closer to the end we are interested in
        if (limit && s.lastTapRequest && (s.lastTapRequest + 40000 > Date.now())) return;
        doSend(ipp, {
            '.tap': tapRequests[ipp]
        });
        if(limit) s.lastTapRequest = Date.now();
    });
}

//setup a connector to indicate what ends we want to communicate with
//only one connector per end is created. The connectors role is to constantly dial the end only
//returns the connector object used to actually send signals to the end.
function doConnect(end_name, noResponse) {
    if (!self.me) return;
    if (self.state != STATE.online ) return;
    
    if( connectors[end_name] ) return connectors[end_name];
        
    connectors[end_name] = {
        id: end_name,
        snat: (self.snat ? true : false ),//indicator if we are behind snat
        send:function(message, callback, timeOut){
                var guid = nextGUID();//new guid for message -- RANDOM NUMBER
                if(callback && self.mode != MODE.ANNOUNCER ){//dont setup a response handler if we are not interested in a response!                
                    responseHandlers[guid]={ 
                        callback: callback, //add a handler for the responses
                        timeout: timeOut? Date.now()+(timeOut*1000):Date.now()+(10*1000),  //responses must arrive within timeOut seconds, or default 10 seconds
                        responses:0 //tracks number of responses to the outgoing telex.
                    };
                }     
                //send the message
                if(callback && !noResponse && self.mode != MODE.ANNOUNCER ){
                    //changed to send end instead of ip:port. (maintain some anonymity)
                    //if ip:port needs to be shared..send it in the message.
                    doAnnounce(end_name, {'+connect':guid,'+from':self.me.end,'+message':message});
                }else{
                    //dont share our ip.. if we dont have to
                    doAnnounce(end_name, {'+connect':guid,'+message':message});
                }
                //console.error("Sending message: " + JSON.stringify(message)+" guid:"+guid);
            }
    };

    if(self.mode != MODE.ANNOUNCER && !noResponse ){
        listenForResponse({
            id: self.me.ipp,
            connect: end_name
        }, undefined);
    }

    //console.error("ADDED CONNECTOR TO: " + end_name);
    connectLoop(); //kick start connector
    
    return connectors[end_name];
}

function connectLoop() {
    if (self && self.state != STATE.online) return;
    
    timeoutResponseHandlers();
    
    // dial the end continuously, timer to re-dial closest, wait forever for response and call back
    for (var end in connectors) {
        doDial( end );
    }
}
//some lower level functions
function doTap(end, rule, callback){
    if(self.mode == MODE.ANNOUNCER) return;
    var hash = new hlib.Hash(end);
    var listener = {
        id: end,
        hash: hash,
        end: hash.toString(),
        rule: rule,
        cb: callback
    };
    listeners.push(listener);
    //console.error("ADDED LISTENER FOR: "+end);
    return listener;
}


function doAnnounce(end, signals){
    if (self.snat) signals['+snat'] = true;
    signals['_hop'] = 1;
    var hash = new hlib.Hash(end);
    signals['+end']=hash.toString();
    var switches = slib.getNear(hash);
    switches.forEach(function (ipp) {
        doSend(ipp,signals);//fix: signals telex is being altered.. need to make a copy of telex before sending to multiple switches
    });
}

function doDial( end ){
    var hash = new hlib.Hash(end);
    var switches = slib.getNear(hash);
    switches.forEach(function (ipp) {
        doSend(ipp, {
            '+end': hash.toString(),
            '_hop':0
        });
    });
    return hash.toString();
}

function doPing(to){
    doSend(to, {
        '+end': self.me.end,
        '_hop': 0,
        '.see': self.me.visible ? [self.me.ipp] : []
    });
}

function doSend(to, telex) {
    //if behind NAT, don't send to a switch with the same ip as us
    //if a NAT/firewall supports 'hair-pinning' we could allow it
    if (self.nat) {
        if (self.me && util.isSameIP(self.me.ipp, to)) return;
    }

    var s = slib.getSwitch(to);

    //eliminate duplicate +end dial signals going to same switch in short-span of time.
    if (telex['+end'] && (!telex['_hop'] || telex['_hop']==0)) {
        var end = telex['+end'];
        if (!s.pings) s.pings = {}; //track last ping time, indexed by +end hash
        if (s.pings[end] && ((s.pings[end] + 15000) > Date.now())) return;
        s.pings[end] = Date.now();
    }

    if (s.popped || self.snat) {
        s.send(telex);
    } else {
        //we need to +pop it, first time connecting..
        sendPOPRequest(to);
        //give the +pop signal a head start before we send out the telex
        setTimeout(function () { 
            s.send(telex);
        }, 2000);//too long?
    }
}

function doShutdown() {
    self.mode = MODE.offline;
    clearTimeout(self.scanTimeout);
    clearInterval(self.connect_listen_Interval);
    if (self.seedTimeout) {
        self.onSeeded("shutdown"); // a callback still waiting?!
        delete self.seedTimeout;
    }
    // drop all switches
    slib.getSwitches().forEach(function (s) {
        s.drop()
    });
    self.server.close();
    self = undefined;
    listeners = [];
    connectors = {};
    responseHandlers = {};
}

function connect_listen() {
    if (self && self.state != STATE.online) return;
    listenLoop();
    connectLoop();
}

// scan all known switches regularly to keep a good network map alive and trim the rest
function scan() {
    if (self.state != STATE.online) return;

    if (!this.count) this.count = 1;

    var all = slib.getSwitches();
    console.error("------" + this.count++);

    // first just cull any not healthy, easy enough
    all.forEach(function (s) {
        if (!s.healthy()) s.drop();
    });

    all = slib.getSwitches();

    all.forEach(function (s) {
        if (s.self) return;
        console.error("switch:",s.ipp,"visible:",s.visible,"line:",s.line,"misses:",s.misses,"healthy:",s.healthy());
    });

    // if only us or nobody around, and we were seeded at one point, try again!
    // unless we are the seed..    
    if(all.length <= 1 && !self.seed )
    {	//We probably lost our internet connection at this point.. or maybe
        //it just got disrupted:(DSL/pppoE DHCP lease renewed, if on a mobile we changed cells, signal lost etc..
        self.state = STATE.offline;
        return doSeed(self.onSeeded);//TODO: emit event state changed..
    }

    //if we lost connection to all initial seeds.. ping them all again?
    var foundSeed = false;
    all.forEach(function (s) {
        if (s.seed) foundSeed = true;
    });
    if (!foundSeed) {
        pingSeeds();
    }

    if(!self.mode == MODE.FULL) return;
        
    // TODO overall, ping first X of each bucket
    all = all.filter(function(a){
        return (a.visible && !a.self);
    });
    all.sort(function (a, b) {
        return self.me.hash.distanceTo(a.hash) - self.me.hash.distanceTo(b.hash);
    });

    if(!all.length) return;

    // create array of arrays (buckets) based on distance from self (the heart of kademlia)
    var distance = self.me.hash.distanceTo(all[0].hash); // first bucket
    var buckets = [];
    var bucket = [];
    all.forEach(function (s) {
        var d2 = self.me.hash.distanceTo(s.hash);
        if (d2 == distance) {
            console.error(s.ipp,'bucket:',buckets.length,"distance:",distance);
            return bucket.push(s);
        }
        buckets.push(bucket);//store bucket
        
        distance = d2;        
        bucket = [s];//put it in next bucket
        console.error(s.ipp,'bucket:',buckets.length,"distance:",distance);
    });

    // TODO for congested buckets have a sort preference towards stable, and have a max cap and drop rest (to help avoid a form of local flooding)
    // for now, ping everyone!
    buckets.forEach(function (bucket) {
        bucket.forEach(function (s) {
            if (s.self) return;
            if (Date.now() > (s.ATsent + 30000)) return; // don't need to ping if already sent them something in the last 30sec
            console.error('pinging ' + s.ipp + " ...");
            doPing(s.ipp);
            // TODO, best dht mesh balance is probably to generate a random hash this distance away, but greedy +end of us is always smart/safe
        })
    });
}

//http://comments.gmane.org/gmane.comp.lang.javascript.nodejs/2378
function randomString(bits){
  var chars,rand,i,ret;
  chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  ret='';
  // in v8, Math.random() yields 32 pseudo-random bits
  while(bits > 0){
    rand=Math.floor(Math.random()*0x100000000) // 32-bit integer
    // base 64 means 6 bits per character, so we use the top 30 bits from rand to give 30/6=5 characters.
    for(i=26; i>0 && bits>0; i-=6, bits-=6){ ret+=chars[0x3F & rand >>> i]; }
  }
  return ret
}
  
function nextGUID(){
    return randomString(64);
}