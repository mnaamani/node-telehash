var telehash = require("../index.js").telehash;
var util = require('../lib/iputil');

var localip = util.getLocalIP();

if (localip.length) {
	telehash.init({
		log: console.log,
		mode: 3, // full operating mode
		port: '42424',
		respondToBroadcasts: false, //self seeding hosts should dlisten on a single ip (not 0.0.0.0)
		seeds: [localip[0] + ":42424"], // self seed
	}, function (err, info) {
		if (!err) {
			console.log(info.socket.address());
			telehash.seed(function (status) {
				console.log(status);
			});
		}
	});
}
