/**
 * @fileoverview SIP Dialog
 */

/**
 * @augments ExSIP
 * @class Class creating a SIP dialog.
 * @param {ExSIP.Session} session
 * @param {ExSIP.IncomingRequest|ExSIP.IncomingResponse} message
 * @param {Enum} type UAC / UAS
 * @param {Enum} state ExSIP.Dialog.C.STATUS_EARLY / ExSIP.Dialog.C.STATUS_CONFIRMED
 */
(function(ExSIP) {
var Dialog,
  logger = new ExSIP.Logger(ExSIP.name +' | '+ 'DIALOG'),
  C = {
    // Dialog states
    STATUS_EARLY:        1,
    STATUS_CONFIRMED:    2
  };

// RFC 3261 12.1
Dialog = function(session, message, type, state) {
  var contact;

  if(!message.hasHeader('contact')) {
    logger.error('unable to create a Dialog without Contact header field');
    return false;
  }

  if(message instanceof ExSIP.IncomingResponse) {
    state = (message.status_code < 200) ? C.STATUS_EARLY : C.STATUS_CONFIRMED;
  } else {
    // Create confirmed dialog if state is not defined
    state = state || C.STATUS_CONFIRMED;
  }

  contact = message.parseHeader('contact');

  this.is_acknowledged = false;
  this.type = type;
  // RFC 3261 12.1.1
  if(type === 'UAS') {
    this.id = {
      call_id: message.call_id,
      local_tag: message.to_tag,
      remote_tag: message.from_tag,
      toString: function() {
        return this.call_id + this.local_tag + this.remote_tag;
      }
    };
    this.state = state;
    this.remote_seqnum = message.cseq;
    this.local_uri = message.parseHeader('to').uri;
    this.remote_uri = message.parseHeader('from').uri;
    this.remote_target = contact.uri;
    this.route_set = message.getHeaderAll('record-route');
  }
  // RFC 3261 12.1.2
  else if(type === 'UAC') {
    this.id = {
      call_id: message.call_id,
      local_tag: message.from_tag,
      remote_tag: message.to_tag,
      toString: function() {
        return this.call_id + this.local_tag + this.remote_tag;
      }
    };
    this.state = state;
    this.local_seqnum = message.cseq;
    this.local_uri = message.parseHeader('from').uri;
    this.remote_uri = message.parseHeader('to').uri;
    this.remote_target = contact.uri;
    this.route_set = message.getHeaderAll('record-route').reverse();
  }

  this.session = session;
  session.ua.dialogs[this.id.toString()] = this;
  logger.log('new ' + type + ' dialog created with status ' + (this.state === C.STATUS_EARLY ? 'EARLY': 'CONFIRMED'), session.ua);
};

Dialog.prototype = {
  /**
   * @param {ExSIP.IncomingMessage} message
   * @param {Enum} UAC/UAS
   */
  isUAS: function() {
    return this.type === "UAS";
  },

  isUAC: function() {
    return this.type === "UAC";
  },

  update: function(message, type) {
    this.state = C.STATUS_CONFIRMED;

    logger.log('dialog '+ this.id.toString() +'  changed to CONFIRMED state', this.session.ua);

    if(type === 'UAC') {
      // RFC 3261 13.2.2.4
      this.route_set = message.getHeaderAll('record-route').reverse();
    }
  },

  terminate: function() {
    logger.log('dialog ' + this.id.toString() + ' deleted', this.session.ua);
    delete this.session.ua.dialogs[this.id.toString()];
  },

  /**
  * @param {String} method request method
  * @param {Object} extraHeaders extra headers
  * @returns {ExSIP.OutgoingRequest}
  */

  // RFC 3261 12.2.1.1
  createRequest: function(method, extraHeaders) {
    var cseq, request;
    extraHeaders = extraHeaders || [];

    if(!this.local_seqnum) { this.local_seqnum = Math.floor(Math.random() * 10000); }

    cseq = (method === ExSIP.C.CANCEL || method === ExSIP.C.ACK) ? this.local_seqnum : this.local_seqnum += 1;

    request = new ExSIP.OutgoingRequest(
      method,
      this.remote_target,
      this.session.ua, {
        'cseq': cseq,
        'call_id': this.id.call_id,
        'from_uri': this.local_uri,
        'from_tag': this.id.local_tag,
        'to_uri': this.remote_uri,
        'to_tag': this.id.remote_tag,
        'route_set': this.route_set
      }, extraHeaders);

    request.dialog = this;

    return request;
  },

  /**
  * @param {ExSIP.IncomingRequest} request
  * @returns {Boolean}
  */

  // RFC 3261 12.2.2
  checkInDialogRequest: function(request) {
    switch(request.method) {
      // RFC3261 14.2 Modifying an Existing Session -UAS BEHAVIOR-
      case ExSIP.C.INVITE:
        var retryAfter = (Math.random() * 10 | 0) + 1;
        if(request.cseq < this.remote_seqnum) {
          if(this.state === C.STATUS_EARLY) {
            request.reply(500, null, ['Retry-After:'+ retryAfter]);
          } else {
            request.reply(500);
          }
          return false;
        }
        // RFC3261 14.2
        if(this.state === C.STATUS_EARLY) {
          request.reply(491);
          return false;
        }
        if(this.type === 'UAS' && !this.is_acknowledged) {
          request.reply(500, null, ['Retry-After:'+ retryAfter]);
          return false;
        }
        // RFC3261 12.2.2 Replace the dialog`s remote target URI
        if(request.hasHeader('contact')) {
          this.remote_target = request.parseHeader('contact').uri;
        }
        break;
      case ExSIP.C.NOTIFY:
        // RFC6655 3.2 Replace the dialog`s remote target URI
        if(request.hasHeader('contact')) {
          this.remote_target = request.parseHeader('contact').uri;
        }
        break;
      case ExSIP.C.ACK:
        this.is_acknowledged = true;
        break;
    }

    if(!this.remote_seqnum) {
      this.remote_seqnum = request.cseq;
    } else if(request.method !== ExSIP.C.INVITE && request.cseq < this.remote_seqnum) {
        //Do not try to reply to an ACK request.
        if (request.method !== ExSIP.C.ACK) {
          request.reply(500);
        }
        return false;
    } else if(request.cseq > this.remote_seqnum) {
      this.remote_seqnum = request.cseq;
    }

    return true;
  },

  /**
  * @param {ExSIP.IncomingRequest} request
  */
  receiveRequest: function(request) {
    //Check in-dialog request
    if(!this.checkInDialogRequest(request)) {
      return;
    }

    this.session.receiveRequest(request);
  }
};

Dialog.C = C;
ExSIP.Dialog = Dialog;
}(ExSIP));
