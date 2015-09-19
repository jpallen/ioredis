'use strict';

var ReplyError = require('../reply_error');
var events = require('events');
var util = require('util');

var START_FLAG = {
  STRING:   43, // +
  ERROR:    45, // -
  INTEGER:  58, // :
  BULK:     36, // $
  ARRAY:    42  // *
};

var END_FLAG = [0x0d, 0x0a];
var MAX_BUFFER_SIZE = 20000000;

function Parser() {
  this.sectionStack = [];
  this.size = 0;
  this.arrayIndex = null;
  this.buffer = new Buffer(MAX_BUFFER_SIZE);
}

util.inherits(Parser, events.EventEmitter);

Parser.prototype.execute = function (buffer) {
  if (!buffer) {
    return;
  }
  var bufferLength = buffer.length;

  if (this.size + bufferLength > MAX_BUFFER_SIZE) {
    this.buffer = Buffer.concat([this.buffer, buffer]);
  } else {
    buffer.copy(this.buffer, this.size);
  }
  this.size += bufferLength;

  var totalSize = this.size;
  for (var i = this.size - bufferLength; i < totalSize; i++) {
    var lastSection = this.sectionStack.length && this.sectionStack[this.sectionStack.length - 1];

    if (lastSection && lastSection.type === 'BULK') {
      lastSection.pending -= 1;
      if (lastSection.pending === 0) {
        var section = this.sectionStack[this.sectionStack.length - 1];
        this.sectionStack[this.sectionStack.length - 1] = { type: 'EMPTY', offset: section.offset + 1 };
        var result = this.buffer.slice(section.start, i + 1);
        this.size = section.offset;
        if (section.array === null) {
          this.send_reply(result);
        } else {
          this.sectionStack[section.array].replies.push(result);
          this.sectionStack[section.array].pending -= 1;
          if (this.sectionStack[section.array].pending === 0) {
            this.send_reply(this.sectionStack[section.array].replies);
            this.sectionStack.pop();
          }
        }
      }
      continue;
    }

    var c = this.buffer[i];
    var offset = i;
    switch (c) {
      case START_FLAG.STRING: this.sectionStack.push({ type: 'STRING', offset: offset, array: this.arrayIndex }); break;
      case START_FLAG.ERROR: this.sectionStack.push({ type: 'ERROR', offset: offset, array: this.arrayIndex }); break;
      case START_FLAG.INTEGER: this.sectionStack.push({ type: 'INTEGER', offset: offset, array: this.arrayIndex }); break;
      case START_FLAG.BULK:
        this.sectionStack.push({ type: 'BULK', offset: offset, array: this.arrayIndex });
        this.sectionStack.push({ type: 'BULK_COUNT', offset: offset, array: this.arrayIndex });
        break;
      case START_FLAG.Array:
        this.sectionStack.push({ type: 'Array', offset: offset, array: this.arrayIndex });
        this.sectionStack.push({ type: 'Array_COUNT', offset: offset, array: this.arrayIndex });
        this.arrayIndex = this.sectionStack.length - 2;
        break;
      case END_FLAG[0]:
        this.sectionStack.push({ type: 'END_START', offset: offset, array: this.arrayIndex });
        break;
      case END_FLAG[1]:
        if (!lastSection || lastSection.type !== 'END_START') {
          throw new Error('No END_START found');
        }
        this.sectionStack.pop();
        if (!this.sectionStack.length) {
          continue;
        }
        var section = this.sectionStack.pop();
        var result = this.buffer.slice(section.offset + 1, i - 1);
        this.size = section.offset - 1;
        if (this.size < 0) {
          this.size = 0;
        }
        switch (section.type) {
          case 'STRING':
            if (section.array === null) {
              this.send_reply(result);
            } else {
              this.sectionStack[section.array].replies.push(result);
              this.sectionStack[section.array].pending -= 1;
              if (this.sectionStack[section.array].pending === 0) {
                this.send_reply(this.sectionStack[section.array].replies);
                this.sectionStack.pop();
              }
            }
            break;
          case 'ERROR':
            if (section.array === null) {
              this.send_reply(new ReplyError(result.toString()));
            } else {
              this.sectionStack[section.array].replies.push(new ReplyError(result.toString()));
              this.sectionStack[section.array].pending -= 1;
              if (this.sectionStack[section.array].pending === 0) {
                this.send_reply(this.sectionStack[section.array].replies);
                this.sectionStack.pop();
              }
            }
            break;
          case 'INTEGER':
            if (section.array === null) {
              this.send_reply(Number(result.toString()));
            } else {
              this.sectionStack[section.array].replies.push(Number(result.toString()));
              this.sectionStack[section.array].pending -= 1;
              if (this.sectionStack[section.array].pending === 0) {
                this.send_reply(this.sectionStack[section.array].replies);
                this.sectionStack.pop();
              }
            }
            break;
          case 'BULK_COUNT':
            this.sectionStack[this.sectionStack.length - 1].pending = Number(result.toString());
            this.sectionStack[this.sectionStack.length - 1].start = i + 1;
            break;
          case 'ARRAY_COUNT':
            this.sectionStack[this.sectionStack.length - 1].pending = Number(result.toString());
            this.sectionStack[this.sectionStack.length - 1].replies = [];
            break;
        }
        break;

    }
  }
};

Parser.prototype.send_reply = function (reply) {
  this.emit('reply', reply);
};

module.exports = Parser;