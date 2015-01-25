// Pthread Web Worker startup routine:
// This is the entry point file that is loaded first by each Web Worker
// that executes pthreads on the Emscripten application.

// All pthreads share the same Emscripten HEAP as SharedArrayBuffer
// with the main execution thread.
var buffer;

var threadBlock = 0; // Info area for this thread in Emscripten HEAP (shared). If zero, this worker is not currently hosting an executing pthread.

var selfThreadId = 0; // The ID of this thread. 0 if not hosting a pthread.

// Each thread has its own allocated stack space.
var STACK_BASE = 0;
var STACKTOP = 0;
var STACK_MAX = 0;

var ENVIRONMENT_IS_PTHREAD = true;

// Cannot use console.log or console.error in a web worker, since that would risk a browser deadlock! https://bugzilla.mozilla.org/show_bug.cgi?id=1049091
// Therefore implement custom logging facility for threads running in a worker, which queue the messages to main thread to print.
var Module = {};

function threadPrint() {
  var text = Array.prototype.slice.call(arguments).join(' ');
  postMessage({cmd: 'print', text: text, threadId: selfThreadId});
}
function threadPrintErr() {
  var text = Array.prototype.slice.call(arguments).join(' ');
  postMessage({cmd: 'printErr', text: text, threadId: selfThreadId});
}

Module['print'] = threadPrint;
Module['printErr'] = threadPrintErr;

// Work around https://bugzilla.mozilla.org/show_bug.cgi?id=1049091
console = {
  log: threadPrint,
  error: threadPrintErr
};

this.onmessage = function(e) {
  if (e.data.cmd == 'load') { // Preload command that is called once per worker to parse and load the Emscripten code.
    buffer = e.data.buffer;
    importScripts(e.data.url);
    postMessage({ cmd: 'loaded' });
  } else if (e.data.cmd == 'run') { // This worker was idle, and now should start executing its pthread entry point.
    threadBlock = e.data.threadBlock;
    assert(threadBlock);
    selfThreadId = e.data.selfThreadId;
    assert(selfThreadId);
    // TODO: Emscripten runtime has these variables twice(!), once outside the asm.js module, and a second time inside the asm.js module.
    //       Review why that is? Can those get out of sync?
    STACK_BASE = STACKTOP = e.data.stackBase;
    STACK_MAX = STACK_BASE + e.data.stackSize;
    assert(STACK_BASE != 0);
    assert(STACK_MAX > STACK_BASE);
    Runtime.establishStackSpace(e.data.stackBase, e.data.stackBase + e.data.stackSize);
    var result = 0;
    try {
      // HACK: Some code in the wild has instead signatures of form 'void *ThreadMain()', which seems to be ok in native code.
      // To emulate supporting both in test suites, use the following form. This is brittle!
      if (typeof asm['dynCall_ii'] !== 'undefined')
        result = asm.dynCall_ii(e.data.start_routine, e.data.arg); // pthread entry points are always of signature 'void *ThreadMain(void *arg)'
      else
        result = asm.dynCall_i(e.data.start_routine); // as a hack, try signature 'i' as fallback.
    } catch(e) {
      Atomics.store(HEAPU32, (threadBlock + 0 /*{{{ C_STRUCTS.pthread.threadStatus }}}*/ ) >> 2, 1); // Mark the thread as no longer running.
      if (e === 'Canceled!') {
        PThread.threadCancel();
        return;
      } else {
        Atomics.store(HEAPU32, (threadBlock + 4 /*{{{ C_STRUCTS.pthread.threadExitCode }}}*/ ) >> 2, -2 /*A custom entry specific to Emscripten denoting that the thread crashed.*/);
        throw e;
      }
    }
    // The thread might have finished without calling pthread_exit(). If so, then perform the exit operation ourselves.
    // (This is a no-op if explicit pthread_exit() had been called prior.)
    PThread.threadExit(result);
  } else if (e.data.cmd == 'cancel') { // Main thread is asking for a pthread_cancel() on this thread.
    if (threadBlock && PThread.thisThreadCancelState == 0/*PTHREAD_CANCEL_ENABLE*/) {
      PThread.threadCancel();
    }
  } else {
    Module['printErr']('pthread-main.js received unknown command ' + e.data.cmd);
  }
}
