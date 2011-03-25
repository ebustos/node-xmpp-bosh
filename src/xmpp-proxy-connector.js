/*
 * Copyright (c) 2011 Dhruv Matani
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */

var xp     = require('./xmpp-proxy.js');
var us     = require('./underscore.js');
var dutil  = require('./dutil.js');
var lookup = require('./lookup-service.js');
var util   = require('util');


var _30_MINUTES_IN_SEC = 30 * 60;
var _60_MINUTES_IN_SEC = 60 * 60;

var DEFAULT_XMPP_PORT = 5222;


// Note: The way we calculate inactivity is not from the BOSH layer, but 
// from the XMPP layer. If the client is making BOSH connections but sending
// or receiving empty packets (no XMPP XML stanzas), then his last 
// activity timestamp shall NOT be updated, and after sufficient amount of 
// time, the client shall be disconnected.

// TODO: Possibly fix the above behaviour to consider HTTP connections absent 
// instead of XMPP activity.




function XMPPProxyConnector(bosh_server) {
	this.Proxy = xp.Proxy;
	this.bosh_server = bosh_server;

	// {
	//   stream_name: {
	//     sstate: sstate, 
	//     proxy: The XMPP proxy object for this stream, 
	//     activity: The timestamp of the last activity on this stream (from the BOSH end)
	//     pending: [ An array of pending outgoing stanzas ]
	//   }
	// }
	//
	this.streams = { };


	// Fired when an 'error' event is raised by the XMPP Proxy.
	this._on_xmpp_proxy_error = dutil.hitch(this, function(ex, sstate) {
		// Remove the object and notify the bosh server.
		var ss = this.streams[sstate.name];
		if (!ss) {
			return;
		}

		delete this.streams[sstate.name];
		this.bosh_server.emit('terminate', sstate);
	});

	// Fired every time the XMPP proxy fires the 'stanza' event.
	this._on_stanza_received = dutil.hitch(this, function(stanza, sstate) {
		dutil.log_it("DEBUG", "XMPP PROXY CONNECTOR::Connector received stanza");
		this.bosh_server.emit('response', stanza, sstate);
	});

	// Fired every time the XMPP proxy fires the 'connect' event.
	this._on_xmpp_proxy_connected = dutil.hitch(this, function(sstate) {
		dutil.log_it("DEBUG", "XMPP PROXY CONNECTOR::Received 'connect' event");
		this.bosh_server.emit('stream-added', sstate);

		// Flush out any pending packets.
		var ss = this.streams[sstate.name];
		if (!ss) {
			return;
		}

		ss.pending.forEach(function(ps /* Pending Stanza */) {
			ss.proxy.send(ps.toString());
		});

		ss.pending = [ ];
	});



	var self = this;

	// Setup a BOSH stream garbage collector that terminates 
	// XMPP streams after a certain period of inactivity.
	this._gc_interval = setInterval(function() {
		var skeys = dutil.get_keys(self.streams);
		// dutil.log_it("DEBUG", "XMPP PROXY CONNECTOR::GC timeout::skeys:", skeys);

		var _cts = new Date();

		skeys.forEach(function(k) {
			if (_cts - self.streams[k].activity > _60_MINUTES_IN_SEC * 1000) {
				// Terminate this stream.
				// 1. From the XMPP end
				self.stream_terminate(self.streams[k]);
				// TODO: 2. From the BOSH end.

				dutil.log_it("DEBUG", "XMPP PROXY CONNECTOR::Removing stream:", k);

				// 3. Delete this stream from our set of held streams.
				delete self.streams[k];
			}
		});
	}, _30_MINUTES_IN_SEC * 1000);

}

XMPPProxyConnector.prototype = {
	_update_activity: function(sstate) {
		sstate.activity = new Date();
	},

	stanza: function(stanza, sstate) {
		var ss = this.streams[sstate.name];
		if (!ss) {
			return;
		}

		this._update_activity(ss);

		// TODO:
		// Ideally, we should maintain our own _is_connected flag or some
		// such thing, but for now, we just use the Proxy's internal and
		// supposedly private member _is_connected to quickly make the check
		// that we want to.
		if (ss.proxy._is_connected) {
			// Send only if connected.
			ss.proxy.send(stanza.toString());
		}
		else {
			// Buffer the packet.
			ss.pending.push(stanza);
		}

	}, 

	stream_add: function(sstate) {
		// Check if this stream name exists
		if (this.streams[sstate.name]) {
			return;
		}

		// Create a new stream.
		var proxy = new this.Proxy(sstate.to, 
			new lookup.LookupService(sstate.to, DEFAULT_XMPP_PORT, sstate.state.route), 
			sstate);

		var stream = {
			sstate: sstate, 
			proxy: proxy, 
			activity: new Date(), 
			pending: [ ]
		};
		this.streams[sstate.name] = stream;


		proxy.on('connect', this._on_xmpp_proxy_connected);
		proxy.on('stanza',  this._on_stanza_received);
		proxy.on('error',   this._on_xmpp_proxy_error);

		proxy.connect();
	}, 

	stream_restart: function(sstate) {
		// To restart a stream, we just call restart on the XMPPProxy object.
		var ss = this.streams[sstate.name];
		if (!ss) {
			return;
		}

		this._update_activity(ss);
		ss.proxy.restart();
	}, 

	stream_terminate: function(sstate) {
		// To terminate a stream, we just call terminate on the XMPPProxy object.
		var ss = this.streams[sstate.name];
		if (!ss) {
			return;
		}

		this._update_activity(ss);
		ss.proxy.terminate();
		delete this.streams[sstate.name];
	}, 

	no_client: function(response) {
		// What to do with this response??
		dutil.log_it("WARN", function() {
			return [ "XMPP PROXY CONNECTOR::No Client for this response:", response.toString() ];
		});
	}

};

exports.Connector = XMPPProxyConnector;