// chip-specific support functions
//
// may override function definitions made previously

chipname='sm83';

grChipSize=7348;
grChipOffsetX=0;
grChipOffsetY=-286;
grCanvasSize=7348;
grMaxZoom=24;

ngnd = nodenames['gnd'];
npwr = nodenames['vdd'];

// Index of layerNames corresponds to index into drawLayers
var layernames = ['nwell', 'switched diffusion', 'grounded n-diffusion',
                  'powered p-diffusion', 'polysilicon', 'contact', 'metal'];
var colors = ['rgba(96,64,0,0.6)', '#FFFF00', '#4DFF4D', '#FF4D4D', '#801AC0',
              '#4F4F4F', 'rgba(128,128,192,0.4)'];
var drawlayers = [true, true, true, true, true, true, true];

presetLogLists=[
    ['cycle',],
    ['ab', 'db', '_m1', '_rd', '_wr', '_mreq', '_iorq', 'State', 'pc', 'Fetch'],
    ['a', 'f', 'bc', 'de', 'hl', 'ix', 'iy', 'sp'],
    ['wz', 'ir'],
    ['alubus', '-alua', '-alub', 'aluout', 'alulat'],
    ['d_u', 'r_u', '-ubus', 'r_v', 'u_v', '-vbus', 'regbit', 'r_p', 'pcbit', 'rl_wr', 'rh_wr', 'r_x1'],
    ['dp_dl', 'dl_dp', '-dlatch', 'dl_d', 'd_dl', '-dbus', 'instr', 'load_ir'],
    ['a2', 'f2', 'bc2', 'de2', 'hl2'],
    ['int', 'inta', 'nmi', 'sync_reset', 'async_reset'],
];

// Override ChipSim getNodeValue() function to allow an estimate of capacitance
// (number of connections) to be used when joining floating segments.

function getNodeValue(){
    // 1. deal with power connections first
    if(arrayContains(group, ngnd)) return false;
    if(arrayContains(group, npwr)) return true;
    // 2. deal with pullup/pulldowns next
    for(var i in group){
        var nn = group[i];
        var n = nodes[nn];
        if(n.pullup) return true;
        if(n.pulldown) return false;
    }
    // 3. resolve connected set of floating nodes
    // based on state of largest (by #connections) node
    // (previously this was any node with state true wins)
    var max_state = false;
    var max_connections = 0;
    for(var i in group){
        var nn = group[i];
        var n = nodes[nn];
        var connections = n.gates.length + n.c1c2s.length;
        if (connections > max_connections) {
            max_connections = connections;
            max_state = n.state;
        }
    }
    return max_state;
}

// Override ChipSim drawSeg() to deal with holes
function drawSeg(ctx, seg){
    var dx = grChipOffsetX;
    var dy = grChipOffsetY;
    ctx.beginPath();
    var moveTo = true;
    var sx;
    var sy;
    for (var i=0;i<seg.length;i+=2) {
        if (moveTo) {
            sx = seg[i];
            sy = seg[i+1];
            ctx.moveTo(grScale(sx+dx), grScale(grChipSize-sy+dy));
            moveTo = false;
        } else if (seg[i] == sx && seg[i + 1] == sy) {
            ctx.closePath();
            moveTo = true;
        } else {
            ctx.lineTo(grScale(seg[i]+dx), grScale(grChipSize-seg[i+1]+dy));
        }
    }
    if (!moveTo) {
        ctx.closePath();
    }
}

function setupTransistors(){
    for(i in transdefs){
        var tdef = transdefs[i];
        var name = tdef[0];
        var pmos = tdef[1]=='+';
        var gate = tdef[2];
        var c1 = tdef[3];
        var c2 = tdef[4];
        var bb = tdef[5];
        if(c1==ngnd) {c1=c2;c2=ngnd;}
        if(c1==npwr) {c1=c2;c2=npwr;}
        var trans = {name: name, pmos: pmos, on: false, gate: gate, c1: c1, c2: c2, bb: bb};
        nodes[gate].gates.push(trans);
        nodes[c1].c1c2s.push(trans);
        nodes[c2].c1c2s.push(trans);
        transistors[name] = trans;
    }
}

function stepBack(){
   if(cycle==0) return;
   showState(trace[--cycle].chip);
   setMem(trace[cycle].mem);
   var clk = isNodeHigh(nodenames['clk']);
   if(!clk) writeDataBus(mRead(readAddressBus()));
   chipStatus();
}

// simulate a single clock phase with no update to graphics or trace
function halfStep(){
    var clk = isNodeHigh(nodenames['clk']);
    eval(clockTriggers[cycle]);
    if (clk) {setLow('clk'); }
    else {setHigh('clk'); }
    // DMB: It's almost certainly wrong to execute these on both clock edges
    handleBusRead();
    handleBusWrite();
}

function goUntilSyncOrWrite(){
    halfStep();
    cycle++;
    while(
        !isNodeHigh(nodenames['clk']) ||
            ( isNodeHigh(nodenames['_m1']) && isNodeHigh(nodenames['_wr']) )
    ) {
        halfStep();
        cycle++;
    }
    chipStatus();
}

function initChip(){
    var start = now();
    for(var nn in nodes) {
        nodes[nn].state = false;
        nodes[nn].float = true;
    }

    nodes[ngnd].state = false;
    nodes[ngnd].float = false;
    nodes[npwr].state = true;
    nodes[npwr].float = false;
    for(var tn in transistors) transistors[tn].on = false;
    setLow(nodenamereset);
    setHigh('clk');
    setHigh('_busrq');
    setLow('int0');
    setLow('int1');
    setLow('int2');
    setLow('int3');
    setLow('int4');
    setLow('int5');
    setLow('int6');
    setLow('int7');
    setLow('nmi');
    setLow('wake');
    recalcNodeList(allNodes());
    for(var i=0;i<31;i++){halfStep();} // avoid updating graphics and trace buffer before user code
    setHigh(nodenamereset);
    refresh();
    cycle = 0;
    trace = Array();
    if(typeof expertMode != "undefined")
        updateLogList();
    chipStatus();
    if(ctrace)console.log('initChip done after', now()-start);
}

var prefix       = 0x00;
var opcode       = 0x00;
var state        = 0;
var last_rd_done = 1;

function handleBusRead(){
    if(!isNodeHigh(nodenames['_rd']) && !isNodeHigh(nodenames['_mreq'])) {
        // Memory read
        var a = readAddressBus();
        var d = eval(readTriggers[a]);
        if(d == undefined)
            d = mRead(readAddressBus());
        if(!isNodeHigh(nodenames['_m1'])) {
            eval(fetchTriggers[d]);
        }
        writeDataBus(d);
    } else if(!isNodeHigh(nodenames['_m1']) && !isNodeHigh(nodenames['_iorq'])) {
        // Interrupt acknownledge cycle, force 0xFF onto the bus
        // In IM0 this is seen as JP (HL)
        // In IM1 this is ignored
        // In IM2 this is used as the low byte of the vector
        // TODO: ideally this "vector" would be a configurable parameter
        writeDataBus(0xe9);
    } else {
        // In all other cases we set the data bus to FF
        // as a crude indicateion that it's not being driven
        writeDataBus(0xff);
    }

    // Prefix / displacement / opcode state machine, deals with:
    //   CB <op>
    //   ED <op>
    //   [DD|FD]+ <op>
    //   [DD|FD]+ CB <displacement> <op>

    // Only advance the state machine on the falling edge of read
    if (last_rd_done && !isNodeHigh(nodenames['_rd']) && !isNodeHigh(nodenames['_mreq'])) {
        switch (state) {
        case 0:
            // In state 0 we are ready to start a new instruction
            if(!isNodeHigh(nodenames['_m1'])) {
                prefix = 0;
                opcode = d;
                switch (d) {
                case 0xcb: case 0xed:
                    state = 1;
                    break;
                case 0xdd: case 0xfd:
                    state = 2;
                    break;
                }
            } else {
                // This case covers other reads in the instruction
                prefix = 0;
                opcode = -1;   // If opcode < 0, then no fetch will be displayed
            }
            break;
        case 1:
            // In state 1 we have just seen the CB/ED prefix and expect the opcode
            prefix = opcode; // The prefix(s) just seen
            opcode = d;
            state  = 0;
            break;
        case 2:
            // In state 2 we have just seen the DD/FD prefix
            prefix = opcode; // the prefix just seen
            opcode = d;
            switch (d) {
            case 0xdd: case 0xfd:
                state = 2;   // remain in state 1
                break;
            case 0xcb:
                state = 3;
                break;
            default:
                state = 0;
                break;
            }
            break;
        case 3:
            // In state 3 we expect the displacement byte
            prefix = (prefix << 8) | opcode; // The prefix(s) just seen
            opcode = 0x100; // Trick the disassembler into marking fetch as DISP
            state  = 4;
            break;
        case 4:
            // In state 4 we expect the opcode
            opcode = d;
            state  = 0;
            break;
        default:
            // This should never be needd
            prefix = 0;
            opcode = -1;
            state  = 0;
            break;
        }
    }
    last_rd_done = (isNodeHigh(nodenames['_rd']) || isNodeHigh(nodenames['_mreq']));
}

function handleBusWrite(){
    if(!isNodeHigh(nodenames['_wr'])){
        var a = readAddressBus();
        var d = readDataBus();
        eval(writeTriggers[a]);
        mWrite(a,d);
        if(a<0x200) setCellValue(a,d);
    }
}

function readA() {
    if (!isNodeHigh(nodenames['ex_af'])) {
        return readBits('reg_aa', 8);
    } else {
        return readBits('reg_a', 8);
    }
}

function readF() {
    if (!isNodeHigh(nodenames['ex_af'])) {
        return readBits('reg_ff', 8);
    } else {
        return readBits('reg_f', 8);
    }
}

function readB() {
    if (isNodeHigh(nodenames['ex_bcdehl'])) {
        return readBits('reg_bb', 8);
    } else {
        return readBits('reg_b', 8);
    }
}

function readC() {
    if (isNodeHigh(nodenames['ex_bcdehl'])) {
        return readBits('reg_cc', 8);
    } else {
        return readBits('reg_c', 8);
    }
}

function readD() {
    if (isNodeHigh(nodenames['ex_bcdehl'])) {
        if (isNodeHigh(nodenames['ex_dehl1'])) {
            return readBits('reg_hh', 8);
        } else {
            return readBits('reg_dd', 8);
        }
    } else {
        if (isNodeHigh(nodenames['ex_dehl0'])) {
            return readBits('reg_h', 8);
        } else {
            return readBits('reg_d', 8);
        }
    }
}

function readE() {
    if (isNodeHigh(nodenames['ex_bcdehl'])) {
        if (isNodeHigh(nodenames['ex_dehl1'])) {
            return readBits('reg_ll', 8);
        } else {
            return readBits('reg_ee', 8);
        }
    } else {
        if (isNodeHigh(nodenames['ex_dehl0'])) {
            return readBits('reg_l', 8);
        } else {
            return readBits('reg_e', 8);
        }
    }
}

function readH() {
    if (isNodeHigh(nodenames['ex_bcdehl'])) {
        if (isNodeHigh(nodenames['ex_dehl1'])) {
            return readBits('reg_dd', 8);
        } else {
            return readBits('reg_hh', 8);
        }
    } else {
        if (isNodeHigh(nodenames['ex_dehl0'])) {
            return readBits('reg_d', 8);
        } else {
            return readBits('reg_h', 8);
        }
    }
}

function readL() {
    if (isNodeHigh(nodenames['ex_bcdehl'])) {
        if (isNodeHigh(nodenames['ex_dehl1'])) {
            return readBits('reg_ee', 8);
        } else {
            return readBits('reg_ll', 8);
        }
    } else {
        if (isNodeHigh(nodenames['ex_dehl0'])) {
            return readBits('reg_e', 8);
        } else {
            return readBits('reg_l', 8);
        }
    }
}

function readA2() {
    if (isNodeHigh(nodenames['ex_af'])) {
        return readBits('reg_aa', 8);
    } else {
        return readBits('reg_a', 8);
    }
}

function readF2() {
    if (isNodeHigh(nodenames['ex_af'])) {
        return readBits('reg_ff', 8);
    } else {
        return readBits('reg_f', 8);
    }
}

function readB2() {
    if (!isNodeHigh(nodenames['ex_bcdehl'])) {
        return readBits('reg_bb', 8);
    } else {
        return readBits('reg_b', 8);
    }
}

function readC2() {
    if (!isNodeHigh(nodenames['ex_bcdehl'])) {
        return readBits('reg_cc', 8);
    } else {
        return readBits('reg_c', 8);
    }
}

function readD2() {
    if (!isNodeHigh(nodenames['ex_bcdehl'])) {
        if (isNodeHigh(nodenames['ex_dehl1'])) {
            return readBits('reg_hh', 8);
        } else {
            return readBits('reg_dd', 8);
        }
    } else {
        if (isNodeHigh(nodenames['ex_dehl0'])) {
            return readBits('reg_h', 8);
        } else {
            return readBits('reg_d', 8);
        }
    }
}

function readE2() {
    if (!isNodeHigh(nodenames['ex_bcdehl'])) {
        if (isNodeHigh(nodenames['ex_dehl1'])) {
            return readBits('reg_ll', 8);
        } else {
            return readBits('reg_ee', 8);
        }
    } else {
        if (isNodeHigh(nodenames['ex_dehl0'])) {
            return readBits('reg_l', 8);
        } else {
            return readBits('reg_e', 8);
        }
    }
}

function readH2() {
    if (!isNodeHigh(nodenames['ex_bcdehl'])) {
        if (isNodeHigh(nodenames['ex_dehl1'])) {
            return readBits('reg_dd', 8);
        } else {
            return readBits('reg_hh', 8);
        }
    } else {
        if (isNodeHigh(nodenames['ex_dehl0'])) {
            return readBits('reg_d', 8);
        } else {
            return readBits('reg_h', 8);
        }
    }
}

function readL2() {
    if (!isNodeHigh(nodenames['ex_bcdehl'])) {
        if (isNodeHigh(nodenames['ex_dehl1'])) {
            return readBits('reg_ee', 8);
        } else {
            return readBits('reg_ll', 8);
        }
    } else {
        if (isNodeHigh(nodenames['ex_dehl0'])) {
            return readBits('reg_e', 8);
        } else {
            return readBits('reg_l', 8);
        }
    }
}

function readI(){return readBits('reg_i', 8);}
function readR(){return readBits('reg_r', 8);}
function readW(){return readBits('reg_w', 8);}
function readZ(){return readBits('reg_z', 8);}

function readSP(){return (readBits('reg_sph', 8)<<8) + readBits('reg_spl', 8);}
function readPC(){return (readBits('reg_pch', 8)<<8) + readBits('reg_pcl', 8);}
function readPCL(){return readBits('reg_pcl', 8);}
function readPCH(){return readBits('reg_pch', 8);}

function formatFstring(f){
    var result;
    result=
        ((f & 0x80)?'S':'s') +
        ((f & 0x40)?'Z':'z') +
        ((f & 0x20)?'Y':'y') +
        ((f & 0x10)?'H':'h') +
        ((f & 0x08)?'X':'x') +
        ((f & 0x04)?'P':'p') +
        ((f & 0x02)?'N':'n') +
        ((f & 0x01)?'C':'c');
    return result;
}

// The 6800 state control is something like a branching shift register
// ... but not quite like that
TCStates=[
    "m1", "m2", "m3", "m4", "m5",
    "t1", "t2", "t3", "t4", "t5", "t6",
];

function listActiveTCStates() {
    var s=[];
    for(var i=0;i<TCStates.length;i++){
        var t=TCStates[i];
        if (isNodeHigh(nodenames[t])) s.push(t.slice(0,3));
    }
    return s.join(" ");
}

function busToString(busname){
    // takes a signal name or prefix
    // returns an appropriate string representation
    // some 'signal names' are CPU-specific aliases to user-friendly string output
    if(busname=='cycle')
        return cycle>>1;
    if(busname=='a')
        return hexByte(readA());
    if(busname=='f')
        return formatFstring(readF());
    if(busname=='bc')
        return hexByte(readB()) + hexByte(readC());
    if(busname=='de')
        return hexByte(readD()) + hexByte(readE());
    if(busname=='hl')
        return hexByte(readH()) + hexByte(readL());
    if(busname=='wz')
        return busToHex('reg_w') + busToHex('reg_z');
    if(busname=='pc')
        return busToHex('reg_pch') + busToHex('reg_pcl');
    if(busname=='sp')
        return busToHex('reg_sph') + busToHex('reg_spl');
    if(busname=='State')
        return listActiveTCStates();
    // DMB: TODO
    //   if(busname=='Execute')
    //      return disassemblytoHTML(readBits('ir',8));
    if(busname=='Fetch')
        return (!isNodeHigh(nodenames['_mreq']) && !isNodeHigh(nodenames['_rd']) && (opcode >= 0))?disassemblytoHTML(prefix,opcode):"";
    if(busname[0]=="-"){
        // invert the value of the bus for display
        var value=busToHex(busname.slice(1))
        if(typeof value != "undefined")
            return value.replace(/./g,function(x){return (15-parseInt(x,16)).toString(16)});
        else
            return undefined;;
    } else {
        return busToHex(busname);
    }
}

function chipStatus(){
    var ab = readAddressBus();
    var machine1 =
        ' halfcyc:' + cycle +
        ' clk:' + readBit('clk') +
        ' AB:' + hexWord(ab) +
        ' D:' + hexByte(readDataBus()) +
        ' M1:' + readBit('_m1') +
        ' RD:' + readBit('_rd') +
        ' WR:' + readBit('_wr') +
        ' MREQ:' + readBit('_mreq') +
        ' IORQ:' + readBit('_iorq');
    var machine2 =
        ' PC:' + hexWord(readPC()) +
        ' A:'  + hexByte(readA()) +
        ' F:'  + formatFstring(readF()) +
        ' BC:' + hexByte(readB()) + hexByte(readC()) +
        ' DE:' + hexByte(readD()) + hexByte(readE()) +
        ' HL:' + hexByte(readH()) + hexByte(readL()) +
        ' SP:' + hexWord(readSP()) +
        ' WZ:' + hexByte(readW()) + hexByte(readZ());
    var machine3 =
        'State: ' + busToString('State') +
        ' Hz: ' + estimatedHz().toFixed(1);
    if(typeof expertMode != "undefined") {
        // machine3 += ' Exec: ' + busToString('Execute'); // no T-state info for 6800 yet
        if(!isNodeHigh(nodenames['_m1']) && !isNodeHigh(nodenames['_mreq']) && !isNodeHigh(nodenames['_rd']))
            machine3 += ' (Fetch: ' + busToString('Fetch') + ')';
        if(goldenChecksum != undefined)
            machine3 += " Chk:" + traceChecksum + ((traceChecksum==goldenChecksum)?" OK":" no match");
    }

    setStatus(machine1, machine2, machine3);
    if (logThese.length>1) {
        updateLogbox(logThese);
    }
    selectCell(ab);
}

// sanitised opcode for HTML output
function disassemblytoHTML(prefix, opcode){

    var disassembly;
    switch (prefix) {
    case 0xCB:   disassembly = disassembly_cb;   break;
    default:     disassembly = disassembly_00;   break;
    }

    var opstr=disassembly[opcode];
    if(typeof opstr == "undefined")
        return "unknown"
    return opstr.replace(/ /,'&nbsp;');
}


var disassembly_00={

    0x00: "NOP",
    0x01: "LD BC,NNNN",
    0x02: "LD (BC),A",
    0x03: "INC BC",
    0x04: "INC B",
    0x05: "DEC B",
    0x06: "LD B,NN",
    0x07: "RLCA",
    0x08: "EX AF,AF'",
    0x09: "ADD HL,BC",
    0x0A: "LD A,(BC)",
    0x0B: "DEC BC",
    0x0C: "INC C",
    0x0D: "DEC C",
    0x0E: "LD C,NN",
    0x0F: "RRCA",

    0x10: "DJNZ REL",
    0x11: "LD DE,NNNN",
    0x12: "LD (DE),A",
    0x13: "INC DE",
    0x14: "INC D",
    0x15: "DEC D",
    0x16: "LD D,NN",
    0x17: "RLA",
    0x18: "JR REL",
    0x19: "ADD HL,DE",
    0x1A: "LD A,(DE)",
    0x1B: "DEC DE",
    0x1C: "INC E",
    0x1D: "DEC E",
    0x1E: "LD E,NN",
    0x1F: "RRA",

    0x20: "JR NZ,REL",
    0x21: "LD HL,NNNN",
    0x22: "LD (NNNN),HL",
    0x23: "INC HL",
    0x24: "INC H",
    0x25: "DEC H",
    0x26: "LD H,NN",
    0x27: "DAA",
    0x28: "JR Z,REL",
    0x29: "ADD HL,HL",
    0x2A: "LD HL,(NNNN)",
    0x2B: "DEC HL",
    0x2C: "INC L",
    0x2D: "DEC L",
    0x2E: "LD L,NN",
    0x2F: "CPL",

    0x30: "JR NC,REL",
    0x31: "LD SP,NNNN",
    0x32: "LD (NNNN),A",
    0x33: "INC SP",
    0x34: "INC (HL)",
    0x35: "DEC (HL)",
    0x36: "LD (HL),NN",
    0x37: "SCF",
    0x38: "JR C,REL",
    0x39: "ADD HL,SP",
    0x3A: "LD A,(NNNN)",
    0x3B: "DEC SP",
    0x3C: "INC A",
    0x3D: "DEC A",
    0x3E: "LD A,NN",
    0x3F: "CCF",

    0x40: "LD B,B",
    0x41: "LD B,C",
    0x42: "LD B,D",
    0x43: "LD B,E",
    0x44: "LD B,H",
    0x45: "LD B,L",
    0x46: "LD B,(HL)",
    0x47: "LD B,A",
    0x48: "LD C,B",
    0x49: "LD C,C",
    0x4A: "LD C,D",
    0x4B: "LD C,E",
    0x4C: "LD C,H",
    0x4D: "LD C,L",
    0x4E: "LD C,(HL)",
    0x4F: "LD C,A",

    0x50: "LD D,B",
    0x51: "LD D,C",
    0x52: "LD D,D",
    0x53: "LD D,E",
    0x54: "LD D,H",
    0x55: "LD D,L",
    0x56: "LD D,(HL)",
    0x57: "LD D,A",
    0x58: "LD E,B",
    0x59: "LD E,C",
    0x5A: "LD E,D",
    0x5B: "LD E,E",
    0x5C: "LD E,H",
    0x5D: "LD E,L",
    0x5E: "LD E,(HL)",
    0x5F: "LD E,A",

    0x60: "LD H,B",
    0x61: "LD H,C",
    0x62: "LD H,D",
    0x63: "LD H,E",
    0x64: "LD H,H",
    0x65: "LD H,L",
    0x66: "LD H,(HL)",
    0x67: "LD H,A",
    0x68: "LD L,B",
    0x69: "LD L,C",
    0x6A: "LD L,D",
    0x6B: "LD L,E",
    0x6C: "LD L,H",
    0x6D: "LD L,L",
    0x6E: "LD L,(HL)",
    0x6F: "LD L,A",

    0x70: "LD (HL),B",
    0x71: "LD (HL),C",
    0x72: "LD (HL),D",
    0x73: "LD (HL),E",
    0x74: "LD (HL),H",
    0x75: "LD (HL),L",
    0x76: "HALT",
    0x77: "LD (HL),A",
    0x78: "LD A,B",
    0x79: "LD A,C",
    0x7A: "LD A,D",
    0x7B: "LD A,E",
    0x7C: "LD A,H",
    0x7D: "LD A,L",
    0x7E: "LD A,(HL)",
    0x7F: "LD A,A",

    0x80: "ADD A,B",
    0x81: "ADD A,C",
    0x82: "ADD A,D",
    0x83: "ADD A,E",
    0x84: "ADD A,H",
    0x85: "ADD A,L",
    0x86: "ADD A,(HL)",
    0x87: "ADD A,A",
    0x88: "ADC A,B",
    0x89: "ADC A,C",
    0x8A: "ADC A,D",
    0x8B: "ADC A,E",
    0x8C: "ADC A,H",
    0x8D: "ADC A,L",
    0x8E: "ADC A,(HL)",
    0x8F: "ADC A,A",

    0x90: "SUB B",
    0x91: "SUB C",
    0x92: "SUB D",
    0x93: "SUB E",
    0x94: "SUB H",
    0x95: "SUB L",
    0x96: "SUB (HL)",
    0x97: "SUB A",
    0x98: "SBC A,B",
    0x99: "SBC A,C",
    0x9A: "SBC A,D",
    0x9B: "SBC A,E",
    0x9C: "SBC A,H",
    0x9D: "SBC A,L",
    0x9E: "SBC A,(HL)",
    0x9F: "SBC A,A",

    0xA0: "AND B",
    0xA1: "AND C",
    0xA2: "AND D",
    0xA3: "AND E",
    0xA4: "AND H",
    0xA5: "AND L",
    0xA6: "AND (HL)",
    0xA7: "AND A",
    0xA8: "XOR B",
    0xA9: "XOR C",
    0xAA: "XOR D",
    0xAB: "XOR E",
    0xAC: "XOR H",
    0xAD: "XOR L",
    0xAE: "XOR (HL)",
    0xAF: "XOR A",

    0xB0: "OR B",
    0xB1: "OR C",
    0xB2: "OR D",
    0xB3: "OR E",
    0xB4: "OR H",
    0xB5: "OR L",
    0xB6: "OR (HL)",
    0xB7: "OR A",
    0xB8: "CP B",
    0xB9: "CP C",
    0xBA: "CP D",
    0xBB: "CP E",
    0xBC: "CP H",
    0xBD: "CP L",
    0xBE: "CP (HL)",
    0xBF: "CP A",

    0xC0: "RET NZ",
    0xC1: "POP BC",
    0xC2: "JP NZ,NNNN",
    0xC3: "JP NNNN",
    0xC4: "CALL NZ,NNNN",
    0xC5: "PUSH BC",
    0xC6: "ADD A,NN",
    0xC7: "RST 00h",
    0xC8: "RET Z",
    0xC9: "RET",
    0xCA: "JP Z,NNNN",
    0xCB: "CB PREFIX",
    0xCC: "CALL Z,NNNN",
    0xCD: "CALL NNNN",
    0xCE: "ADC A,NN",
    0xCF: "RST 08h",

    0xD0: "RET NC",
    0xD1: "POP DE",
    0xD2: "JP NC,NNNN",
    0xD3: "OUT (NN),A",
    0xD4: "CALL NC,NNNN",
    0xD5: "PUSH DE",
    0xD6: "SUB NN",
    0xD7: "RST 10h",
    0xD8: "RET C",
    0xD9: "EXX",
    0xDA: "JP C,NNNN",
    0xDB: "IN A,(NN)",
    0xDC: "CALL C,NNNN",
    0xDD: "DD PREFIX",
    0xDE: "SBC A,NN",
    0xDF: "RST 18h",

    0xE0: "RET PO",
    0xE1: "POP HL",
    0xE2: "JP PO,NNNN",
    0xE3: "EX (SP),HL",
    0xE4: "CALL PO,NNNN",
    0xE5: "PUSH HL",
    0xE6: "AND NN",
    0xE7: "RST 20h",
    0xE8: "RET PE",
    0xE9: "JP (HL)",
    0xEA: "JP PE,NNNN",
    0xEB: "EX DE,HL",
    0xEC: "CALL PE,NNNN",
    0xED: "ED PREFIX",
    0xEE: "XOR NN",
    0xEF: "RST 28h",

    0xF0: "RET P",
    0xF1: "POP AF",
    0xF2: "JP P,NNNN",
    0xF3: "DI",
    0xF4: "CALL P,NNNN",
    0xF5: "PUSH AF",
    0xF6: "OR NN",
    0xF7: "RST 30h",
    0xF8: "RET M",
    0xF9: "LD SP,HL",
    0xFA: "JP M,NNNN",
    0xFB: "EI",
    0xFC: "CALL M,NNNN",
    0xFD: "FD PREFIX",
    0xFE: "CP NN",
    0xFF: "RST 38h"
};

var disassembly_cb={

    0x00: "RLC B",
    0x01: "RLC C",
    0x02: "RLC D",
    0x03: "RLC E",
    0x04: "RLC H",
    0x05: "RLC L",
    0x06: "RLC (HL)",
    0x07: "RLC A",
    0x08: "RRC B",
    0x09: "RRC C",
    0x0A: "RRC D",
    0x0B: "RRC E",
    0x0C: "RRC H",
    0x0D: "RRC L",
    0x0E: "RRC (HL)",
    0x0F: "RRC A",

    0x10: "RL B",
    0x11: "RL C",
    0x12: "RL D",
    0x13: "RL E",
    0x14: "RL H",
    0x15: "RL L",
    0x16: "RL (HL)",
    0x17: "RL A",
    0x18: "RR B",
    0x19: "RR C",
    0x1A: "RR D",
    0x1B: "RR E",
    0x1C: "RR H",
    0x1D: "RR L",
    0x1E: "RR (HL)",
    0x1F: "RR A",

    0x20: "SLA B",
    0x21: "SLA C",
    0x22: "SLA D",
    0x23: "SLA E",
    0x24: "SLA H",
    0x25: "SLA L",
    0x26: "SLA (HL)",
    0x27: "SLA A",
    0x28: "SRA B",
    0x29: "SRA C",
    0x2A: "SRA D",
    0x2B: "SRA E",
    0x2C: "SRA H",
    0x2D: "SRA L",
    0x2E: "SRA (HL)",
    0x2F: "SRA A",

    0x30: "SLL B",
    0x31: "SLL C",
    0x32: "SLL D",
    0x33: "SLL E",
    0x34: "SLL H",
    0x35: "SLL L",
    0x36: "SLL (HL)",
    0x37: "SLL A",
    0x38: "SRL B",
    0x39: "SRL C",
    0x3A: "SRL D",
    0x3B: "SRL E",
    0x3C: "SRL H",
    0x3D: "SRL L",
    0x3E: "SRL (HL)",
    0x3F: "SRL A",

    0x40: "BIT 0,B",
    0x41: "BIT 0,C",
    0x42: "BIT 0,D",
    0x43: "BIT 0,E",
    0x44: "BIT 0,H",
    0x45: "BIT 0,L",
    0x46: "BIT 0,(HL)",
    0x47: "BIT 0,A",
    0x48: "BIT 1,B",
    0x49: "BIT 1,C",
    0x4A: "BIT 1,D",
    0x4B: "BIT 1,E",
    0x4C: "BIT 1,H",
    0x4D: "BIT 1,L",
    0x4E: "BIT 1,(HL)",
    0x4F: "BIT 1,A",

    0x50: "BIT 2,B",
    0x51: "BIT 2,C",
    0x52: "BIT 2,D",
    0x53: "BIT 2,E",
    0x54: "BIT 2,H",
    0x55: "BIT 2,L",
    0x56: "BIT 2,(HL)",
    0x57: "BIT 2,A",
    0x58: "BIT 3,B",
    0x59: "BIT 3,C",
    0x5A: "BIT 3,D",
    0x5B: "BIT 3,E",
    0x5C: "BIT 3,H",
    0x5D: "BIT 3,L",
    0x5E: "BIT 3,(HL)",
    0x5F: "BIT 3,A",

    0x60: "BIT 4,B",
    0x61: "BIT 4,C",
    0x62: "BIT 4,D",
    0x63: "BIT 4,E",
    0x64: "BIT 4,H",
    0x65: "BIT 4,L",
    0x66: "BIT 4,(HL)",
    0x67: "BIT 4,A",
    0x68: "BIT 5,B",
    0x69: "BIT 5,C",
    0x6A: "BIT 5,D",
    0x6B: "BIT 5,E",
    0x6C: "BIT 5,H",
    0x6D: "BIT 5,L",
    0x6E: "BIT 5,(HL)",
    0x6F: "BIT 5,A",

    0x70: "BIT 6,B",
    0x71: "BIT 6,C",
    0x72: "BIT 6,D",
    0x73: "BIT 6,E",
    0x74: "BIT 6,H",
    0x75: "BIT 6,L",
    0x76: "BIT 6,(HL)",
    0x77: "BIT 6,A",
    0x78: "BIT 7,B",
    0x79: "BIT 7,C",
    0x7A: "BIT 7,D",
    0x7B: "BIT 7,E",
    0x7C: "BIT 7,H",
    0x7D: "BIT 7,L",
    0x7E: "BIT 7,(HL)",
    0x7F: "BIT 7,A",

    0x80: "RES 0,B",
    0x81: "RES 0,C",
    0x82: "RES 0,D",
    0x83: "RES 0,E",
    0x84: "RES 0,H",
    0x85: "RES 0,L",
    0x86: "RES 0,(HL)",
    0x87: "RES 0,A",
    0x88: "RES 1,B",
    0x89: "RES 1,C",
    0x8A: "RES 1,D",
    0x8B: "RES 1,E",
    0x8C: "RES 1,H",
    0x8D: "RES 1,L",
    0x8E: "RES 1,(HL)",
    0x8F: "RES 1,A",

    0x90: "RES 2,B",
    0x91: "RES 2,C",
    0x92: "RES 2,D",
    0x93: "RES 2,E",
    0x94: "RES 2,H",
    0x95: "RES 2,L",
    0x96: "RES 2,(HL)",
    0x97: "RES 2,A",
    0x98: "RES 3,B",
    0x99: "RES 3,C",
    0x9A: "RES 3,D",
    0x9B: "RES 3,E",
    0x9C: "RES 3,H",
    0x9D: "RES 3,L",
    0x9E: "RES 3,(HL)",
    0x9F: "RES 3,A",

    0xA0: "RES 4,B",
    0xA1: "RES 4,C",
    0xA2: "RES 4,D",
    0xA3: "RES 4,E",
    0xA4: "RES 4,H",
    0xA5: "RES 4,L",
    0xA6: "RES 4,(HL)",
    0xA7: "RES 4,A",
    0xA8: "RES 5,B",
    0xA9: "RES 5,C",
    0xAA: "RES 5,D",
    0xAB: "RES 5,E",
    0xAC: "RES 5,H",
    0xAD: "RES 5,L",
    0xAE: "RES 5,(HL)",
    0xAF: "RES 5,A",

    0xB0: "RES 6,B",
    0xB1: "RES 6,C",
    0xB2: "RES 6,D",
    0xB3: "RES 6,E",
    0xB4: "RES 6,H",
    0xB5: "RES 6,L",
    0xB6: "RES 6,(HL)",
    0xB7: "RES 6,A",
    0xB8: "RES 7,B",
    0xB9: "RES 7,C",
    0xBA: "RES 7,D",
    0xBB: "RES 7,E",
    0xBC: "RES 7,H",
    0xBD: "RES 7,L",
    0xBE: "RES 7,(HL)",
    0xBF: "RES 7,A",

    0xC0: "SET 0,B",
    0xC1: "SET 0,C",
    0xC2: "SET 0,D",
    0xC3: "SET 0,E",
    0xC4: "SET 0,H",
    0xC5: "SET 0,L",
    0xC6: "SET 0,(HL)",
    0xC7: "SET 0,A",
    0xC8: "SET 1,B",
    0xC9: "SET 1,C",
    0xCA: "SET 1,D",
    0xCB: "SET 1,E",
    0xCC: "SET 1,H",
    0xCD: "SET 1,L",
    0xCE: "SET 1,(HL)",
    0xCF: "SET 1,A",

    0xD0: "SET 2,B",
    0xD1: "SET 2,C",
    0xD2: "SET 2,D",
    0xD3: "SET 2,E",
    0xD4: "SET 2,H",
    0xD5: "SET 2,L",
    0xD6: "SET 2,(HL)",
    0xD7: "SET 2,A",
    0xD8: "SET 3,B",
    0xD9: "SET 3,C",
    0xDA: "SET 3,D",
    0xDB: "SET 3,E",
    0xDC: "SET 3,H",
    0xDD: "SET 3,L",
    0xDE: "SET 3,(HL)",
    0xDF: "SET 3,A",

    0xE0: "SET 4,B",
    0xE1: "SET 4,C",
    0xE2: "SET 4,D",
    0xE3: "SET 4,E",
    0xE4: "SET 4,H",
    0xE5: "SET 4,L",
    0xE6: "SET 4,(HL)",
    0xE7: "SET 4,A",
    0xE8: "SET 5,B",
    0xE9: "SET 5,C",
    0xEA: "SET 5,D",
    0xEB: "SET 5,E",
    0xEC: "SET 5,H",
    0xED: "SET 5,L",
    0xEE: "SET 5,(HL)",
    0xEF: "SET 5,A",

    0xF0: "SET 6,B",
    0xF1: "SET 6,C",
    0xF2: "SET 6,D",
    0xF3: "SET 6,E",
    0xF4: "SET 6,H",
    0xF5: "SET 6,L",
    0xF6: "SET 6,(HL)",
    0xF7: "SET 6,A",
    0xF8: "SET 7,B",
    0xF9: "SET 7,C",
    0xFA: "SET 7,D",
    0xFB: "SET 7,E",
    0xFC: "SET 7,H",
    0xFD: "SET 7,L",
    0xFE: "SET 7,(HL)",
    0xFF: "SET 7,A"
};
