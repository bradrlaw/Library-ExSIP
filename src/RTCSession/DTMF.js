/**
 * @fileoverview DTMF
 */

/**
 * @class DTMF
 * @param {ExSIP.RTCSession} session
 */
(function(ExSIP) {

var DTMF,
  logger = new ExSIP.Logger(ExSIP.name +' | '+ 'DTMF'),
  C = {
    MIN_DURATION:            70,
    MAX_DURATION:            6000,
    DEFAULT_DURATION:        100,
    MIN_INTER_TONE_GAP:      50,
    DEFAULT_INTER_TONE_GAP:  500
  };

DTMF = function(session) {
  var events = [
  'succeeded',
  'failed'
  ];

  this.sendTimeoutId = null;
  this.queuedDTMFs = [];
  this.session = session;
  this.direction = null;
  this.tone = null;
  this.duration = null;
  this.interToneGap = null;
  this.dtmfSender = null;

  this.initEvents(events);
};
DTMF.prototype = new ExSIP.EventEmitter();

DTMF.prototype.isDebug = function() {
  return this.session.ua.isDebug();
};

DTMF.prototype.send = function(tone, options) {
  var event, eventHandlers, extraHeaders;

  if (tone === undefined) {
    throw new TypeError('Not enough arguments');
  }

  this.direction = 'outgoing';

  // Check RTCSession Status
  if (this.session.status !== ExSIP.RTCSession.C.STATUS_CONFIRMED && this.session.status !== ExSIP.RTCSession.C.STATUS_WAITING_FOR_ACK) {
    throw new ExSIP.Exceptions.InvalidStateError(this.session.status);
  }

  // Get DTMF options
  options = options || {};
  extraHeaders = options.extraHeaders ? options.extraHeaders.slice() : [];
  eventHandlers = options.eventHandlers || {};

  // Check tone type
  if (typeof tone === 'string' ) {
    tone = tone.toUpperCase();
  } else if (typeof tone === 'number') {
    tone = tone.toString();
  } else {
    throw new TypeError('Invalid tone: '+ tone);
  }

  // Check tone value
  if (!tone.match(/^[0-9A-D#*,]+$/i)) {
    throw new TypeError('Invalid tone: '+ tone);
  } else {
    this.tone = tone;
  }

  // Set event handlers
  for (event in eventHandlers) {
    this.on(event, eventHandlers[event]);
  }

  this.queueTone(this.tone, options.duration, options.interToneGap);
};

DTMF.prototype.processQueuedDTMFs = function() {
  var self = this;
  if(this.queuedDTMFs.length === 0) {
    return;
  }
  if(!this.dtmfSender.canInsertDTMF) {
    logger.log("DTMF Sender cannot insert DTMF - trying again after timeout", this.session.ua);
    this.sendTimeoutId = window.setTimeout(function(){
      self.processQueuedDTMFs();
    }, 1000);
    return;
  }
  var tones = "";
  var durationSum = 0;
  var interToneGapSum = 0;
  for(var i=0; i < this.queuedDTMFs.length; i++) {
    var dtmf = this.queuedDTMFs[i];
    tones += dtmf.tone;
    durationSum += dtmf.duration;
    interToneGapSum += dtmf.interToneGap;
  }
  var duration = durationSum / this.queuedDTMFs.length;
  var interToneGap = interToneGapSum / this.queuedDTMFs.length;

  logger.log("sending DTMF with tones "+tones+", duration "+duration+", gap "+interToneGap, this.session.ua);
  this.dtmfSender.insertDTMF(tones, duration, interToneGap);
};

DTMF.prototype.queueTone = function(tone, duration, interToneGap) {
  logger.log("Queue tone : "+tone, this.session.ua);
  window.clearTimeout(this.sendTimeoutId);
  this.queuedDTMFs.push({tone: tone, duration: duration, interToneGap: interToneGap});
  var self = this;
  this.sendTimeoutId = window.setTimeout(function(){
    self.processQueuedDTMFs();
  }, 2 * duration);
};

DTMF.prototype.onDTMFSent = function(tone) {
  if (!tone) {
    return;
  }

  logger.log("Sent Dtmf tone: <" + tone.tone + ">", this.session.ua);
  for(var i=0; i < this.queuedDTMFs.length; i++) {
    var dtmf = this.queuedDTMFs[i];
    if(tone.tone === dtmf.tone) {
      this.queuedDTMFs.splice(i, 1);
      logger.log("removing from queued tones - remaining queue: \t" + ExSIP.Utils.toString(this.queuedDTMFs), this.session.ua);
      break;
    } else if(dtmf.tone.indexOf(tone.tone) !== -1) {
      dtmf.tone = dtmf.tone.replace(tone.tone, '');
      this.queuedDTMFs[i] = dtmf;
      logger.log("removing from queued tones as contained - remaining queue: \t" + ExSIP.Utils.toString(this.queuedDTMFs), this.session.ua);
      break;
    }
  }
  this.session.emit('newDTMF', this.session, {
    originator: 'local',
    dtmf: this,
    tone: tone.tone
  });
};

DTMF.prototype.enableDtmfSender = function(localstream, peerConnection) {
  var self = this;
  if (localstream != null) {
    var local_audio_track = localstream.getAudioTracks()[0];
    this.dtmfSender = peerConnection.createDTMFSender(local_audio_track);
    logger.log("Created DTMF Sender with canInsertDTMF : "+this.dtmfSender.canInsertDTMF, this.session.ua);

    this.dtmfSender.ontonechange = function(tone) {
      if(tone.tone !== "") {
        self.onDTMFSent(tone);
      }
    };

    this.processQueuedDTMFs();
  }
  else {
    logger.error("No Local Stream to create DTMF Sender");
  }
};

/**
* @private
*/
DTMF.prototype.receiveResponse = function(response) {
  var cause;

  switch(true) {
    case /^1[0-9]{2}$/.test(response.status_code):
      // Ignore provisional responses.
      break;

    case /^2[0-9]{2}$/.test(response.status_code):
      this.emit('succeeded', this, {
        originator: 'remote',
        response: response
      });
      break;

    default:
      cause = ExSIP.Utils.sipErrorCause(response.status_code);
      this.emit('failed', this, {
        originator: 'remote',
        response: response,
        cause: cause
      });
      break;
  }
};

/**
 * @private
 */
DTMF.prototype.onRequestTimeout = function() {
  this.emit('failed', this, {
    originator: 'system',
    cause: ExSIP.C.causes.REQUEST_TIMEOUT
  });
};

/**
 * @private
 */
DTMF.prototype.onTransportError = function() {
  this.emit('failed', this, {
    originator: 'system',
    cause: ExSIP.C.causes.CONNECTION_ERROR
  });
};

/**
 * @private
 */
DTMF.prototype.init_incoming = function(request) {
  var body,
    reg_tone = /^(Signal\s*?=\s*?)([0-9A-D#*]{1})(\s)?.*/,
    reg_duration = /^(Duration\s?=\s?)([0-9]{1,4})(\s)?.*/;

  this.direction = 'incoming';
  this.request = request;

  request.reply(200);

  if (request.body) {
    body = request.body.split('\r\n');
    if (body.length === 2) {
      if (reg_tone.test(body[0])) {
        this.tone = body[0].replace(reg_tone,"$2");
      }
      if (reg_duration.test(body[1])) {
        this.duration = parseInt(body[1].replace(reg_duration,"$2"), 10);
      }
    }
  }

  if (!this.tone || !this.duration) {
    logger.warn('invalid INFO DTMF received, discarded', this.session.ua);
  } else {
    this.session.emit('newDTMF', this.session, {
      originator: 'remote',
      dtmf: this,
      request: request
    });
  }
};

DTMF.C = C;
return DTMF;
}(ExSIP));
