/**
 * @fileoverview Provides support for both time-based and cycle-based callbacks
 * @author <a href="mailto:Jeff@pcjs.org">Jeff Parsons</a>
 * @copyright © 2012-2019 Jeff Parsons
 *
 * This file is part of PCjs, a computer emulation software project at <https://www.pcjs.org>.
 *
 * PCjs is free software: you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 *
 * PCjs is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with PCjs.  If not,
 * see <http://www.gnu.org/licenses/gpl.html>.
 *
 * You are required to include the above copyright notice in every modified copy of this work
 * and to display that copyright notice when the software starts running; see COPYRIGHT in
 * <https://www.pcjs.org/modules/devices/machine.js>.
 *
 * Some PCjs files also attempt to load external resource files, such as character-image files,
 * ROM files, and disk image files. Those external resource files are not considered part of PCjs
 * for purposes of the GNU General Public License, and the author does not claim any copyright
 * as to their contents.
 */

"use strict";

/**
 * Timer objects
 *
 * addTimer() and setTimer() create and manage Timer objects that are used for operations that must
 * occur after a certain amount of "real time" has elapsed (eg, key/button events that need to be timed-out
 * after a predefined period).
 *
 * These functions are preferred over JavaScript's setTimeout(), because our timers convert "real time"
 * into cycle countdowns, which are effectively paused whenever cycle generation is paused (eg, when the
 * user stops the emulation).  Moreover, setTimeout() handlers only run after run() yields, which may be
 * too granular for certain devices (eg, when a serial port tries to simulate interrupts at high baud rates).
 *
 * WARNING: If you need to set the 'cyclesPerSecond' TimeConfig property below 60Hz, then 1) you will have
 * to also set 'cyclesMinimum' to an equally low value, otherwise the default minimum will be used, and 2) any
 * timers configured to fire at a faster rate will not be able to; for example, if the machine is configured
 * for 1Hz, then a 60Hz timer will only be able to fire at most 1Hz as well.  In practice, this shouldn't be
 * an issue, as long as the timer is firing at least as frequently as any other work being performed.
 *
 * addClock() should be used for devices that are cycle-driven (ie, that need to be "clocked") rather than
 * time-driven; they must define a clock() function and install it with addClock().
 *
 * Finally, addAnimation() should be used by any device that wants to perform high-speed animations (normally
 * 60Hz); a separate 60Hz timer could be used as well, but using an addAnimation() callback imposes slightly less
 * overhead, since the duration is fixed.  Also, certain types of updates may benefit from the subsequent yield
 * (eg, DOM updates), but you should avoid making expensive updates at such a high frequency.
 *
 * @typedef {Object} Timer
 * @property {string} id
 * @property {function()} callBack
 * @property {number} msAuto
 * @property {number} nCyclesLeft
 */

/**
 * @typedef {Config} TimeConfig
 * @property {string} class
 * @property {Object} [bindings]
 * @property {number} [version]
 * @property {Array.<string>} [overrides]
 * @property {number} [cyclesMinimum]
 * @property {number} [cyclesMaximum]
 * @property {number} [cyclesPerSecond]
 * @property {boolean} [requestAnimationFrame]
 */

/**
 * @class {Time}
 * @unrestricted
 * @property {TimeConfig} config
 * @property {number} nCyclesMinimum
 * @property {number} nCyclesMaximum
 * @property {number} nCyclesPerSecond
 */
class Time extends Device {
    /**
     * Time(idMachine, idDevice, config)
     *
     * Sample config:
     *
     *      "clock": {
     *        "class": "Time",
     *        "cyclesPerSecond": 650000,
     *        "bindings": {
     *          "run": "runTI57",
     *          "speed": "speedTI57",
     *          "step": "stepTI57"
     *        },
     *        "overrides": ["cyclesPerSecond","updatesPerSecond"]
     *      }
     *
     * @this {Time}
     * @param {string} idMachine
     * @param {string} idDevice
     * @param {TimeConfig} [config]
     */
    constructor(idMachine, idDevice, config)
    {
        super(idMachine, idDevice, config);

        this.nCyclesMinimum = this.getDefaultNumber('cyclesMinimum', 1);
        this.nCyclesMaximum = this.getDefaultNumber('cyclesMaximum', 1000000000);
        this.nCyclesPerSecond = this.getBounded(this.getDefaultNumber('cyclesPerSecond', 1000000), this.nCyclesMinimum, this.nCyclesMaximum);
        this.nFramesPerSecond = 60;
        this.nUpdatesPerSecond = this.getDefaultNumber('updatesPerSecond', 2) || 2;
        this.msUpdate = 1000 / this.nUpdatesPerSecond;
        this.msLastUpdate = 0;

        this.nBaseMultiplier = this.nCurrentMultiplier = this.nTargetMultiplier = 1;
        this.mhzBase = (this.nCyclesPerSecond / 10000) / 100;
        this.mhzCurrent = this.mhzTarget = this.mhzBase * this.nTargetMultiplier;
        this.aAnimations = [];
        this.aClocks = [];
        this.aTimers = [];
        this.aUpdates = [];
        this.fPowered = this.fRunning = this.fYield = this.fThrottling = false;
        this.nStepping = 0;
        this.idStepTimeout = this.idAnimationFrame = 0;

        let sRequestAnimationFrame = this.findProperty(window, 'requestAnimationFrame'), timeout;
        if (!sRequestAnimationFrame) {
            sRequestAnimationFrame = 'setTimeout';
            timeout = 1000 / this.nFramesPerSecond;
        }
        this.requestAnimationFrame = window[sRequestAnimationFrame].bind(window, this.run.bind(this), timeout);
        let sCancelAnimationFrame = this.findProperty(window, 'cancelAnimationFrame') || 'clearTimeout';
        this.cancelAnimationFrame = window[sCancelAnimationFrame].bind(window);

        /*
         * Assorted bookkeeping variables.  A running machine actually performs one long series of "runs",
         * each followed by a yield back to the browser.  And each "run" consists of one or more "bursts"; the
         * size and number of "bursts" depends on how often the machine's timers need to fire during the "run".
         */
        this.nCyclesLife = 0;           // number of cycles executed for the lifetime of the machine
        this.nCyclesRun = 0;            // number of cycles executed since the machine was last stopped
        this.nCyclesBurst = 0;          // number of cycles requested for the next "burst"
        this.nCyclesRemain = 0;         // number of cycles remaining in the next "burst"

        /*
         * Now that clocking is driven exclusively by animation frames, calcSpeed() calculates how
         * many cycles each animation frame should "deposit" in our cycle bank:
         *
         *      this.nCyclesDepositPerFrame = (nCyclesPerSecond / nFramesPerSecond) + 0.00000001;
         *
         * After that amount is added to our "balance" (this.nCyclesDeposited), we make a "withdrawal"
         * whenever the balance is >= 1.0 and call all our clocking functions with the maximum number
         * of cycles we were able to withdraw.
         *
         * setSpeed() also adds a tiny amount of "interest" to each "deposit" (0.00000001); otherwise
         * you can end up in situations where the deposit amount is, say, 0.2499999 instead of 0.25,
         * and four such deposits would still fall short of the 1-cycle threshold.
         */
        this.nCyclesDeposited = this.nCyclesDepositPerFrame = 0;

        this.resetSpeed();
    }

    /**
     * addAnimation(callBack)
     *
     * @this {Time}
     * @param {function(number)} callBack
     */
    addAnimation(callBack)
    {
        this.aAnimations.push(callBack);
    }

    /**
     * addBinding(binding, element)
     *
     * @this {Time}
     * @param {string} binding
     * @param {Element} element
     */
    addBinding(binding, element)
    {
        let time = this, elementInput;

        switch(binding) {

        case Time.BINDING.RUN:
            element.onclick = function onClickRun() {
                time.onRun();
            };
            break;

        case Time.BINDING.STEP:
            element.onclick = function onClickStep() {
                time.onStep();
            };
            break;

        case Time.BINDING.THROTTLE:
            elementInput = /** @type {HTMLInputElement} */ (element);
            elementInput.addEventListener("mousedown", function onThrottleStart() {
                time.fThrottling = true;
            });
            elementInput.addEventListener("mouseup", function onThrottleStop() {
                time.setSpeedThrottle();
                time.fThrottling = false;
            });
            elementInput.addEventListener("mousemove", function onThrottleChange() {
                if (time.fThrottling) {
                    time.setSpeedThrottle();
                }
            });
            elementInput.addEventListener("change", function onThrottleChange() {
                time.fThrottling = true;
                time.setSpeedThrottle();
                time.fThrottling = false;
            });
            break;
        }
        super.addBinding(binding, element);
    }

    /**
     * addClock(clock)
     *
     * Adds a clocked device, which must support the following interfaces:
     *
     *      startClock(nCycles)
     *      stopClock()
     *      getClock()
     *
     * @this {Time}
     * @param {Device} clock
     */
    addClock(clock)
    {
        this.aClocks.push(clock);
    }

    /**
     * addTimer(id, callBack, msAuto)
     *
     * Devices that want to have timers that fire after some number of milliseconds call addTimer() to create
     * the timer, and then setTimer() when they want to arm it.  Alternatively, they can specify an automatic
     * timeout value (in milliseconds) to have the timer fire automatically at regular intervals.  There is
     * currently no removeTimer() because these are generally used for the entire lifetime of a device.
     *
     * A timer is initially dormant; dormant timers have a cycle count of -1 (although any negative number will
     * suffice) and active timers have a non-negative cycle count.
     *
     * @this {Time}
     * @param {string} id
     * @param {function()} callBack
     * @param {number} [msAuto] (if set, enables automatic setTimer calls)
     * @return {number} timer index (1-based)
     */
    addTimer(id, callBack, msAuto = -1)
    {
        let nCyclesLeft = -1;
        let iTimer = this.aTimers.length + 1;
        this.aTimers.push({id, callBack, msAuto, nCyclesLeft});
        if (msAuto >= 0) this.setTimer(iTimer, msAuto);
        return iTimer;
    }

    /**
     * addUpdate(device)
     *
     * Adds a device to the update list.  Each device's onUpdate() function is then called from update(),
     * either as the result of a periodic update, single-step updates from step(), or transitional updates
     * from start() and stop().
     *
     * @this {Time}
     * @param {Device} device
     */
    addUpdate(device)
    {
        this.aUpdates.push(device);
    }

    /**
     * calcSpeed(nCycles, msElapsed)
     *
     * @this {Time}
     * @param {number} [nCycles]
     * @param {number} [msElapsed]
     */
    calcSpeed(nCycles, msElapsed)
    {
        let mhz = this.mhzTarget;
        let nCyclesPerSecond = mhz * 1000000;
        if (nCycles && msElapsed) {
            mhz = (nCycles / (msElapsed * 10)) / 100;
            this.printf(MESSAGE.TIME, "calcSpeed(): mhz(%3.3f) = nCycles(%d) / msElapsed(%3.3f)\n", mhz, nCycles, msElapsed);
        }
        this.mhzCurrent = mhz;
        this.nCurrentMultiplier = mhz / this.mhzBase;
        /*
         * If we're running twice as fast as the base speed (say, 4Mhz instead of 2Mhz), then the current multiplier
         * will be 2; similarly, if we're running half as fast as the base speed (say, 1Mhz instead of 2Mhz), the current
         * multiplier will be 0.5.  And ordinarily, we would divide cycles per second by the current multiplier to converge
         * on the target speed, but if the target multiplier has been increased (> 1), then the divisor must be the ratio
         * of current to target.
         */
        let nDivisor = this.nCurrentMultiplier / this.nTargetMultiplier;
        this.nCyclesDepositPerFrame = (nCyclesPerSecond / nDivisor / this.nFramesPerSecond) + 0.00000001;
        this.printf(MESSAGE.TIME, "calcSpeed(): nCyclesDepositPerFrame(%3.3f) = nCyclesPerSecond(%d) / nDivisor(%3.3f) / nFramesPerSecond(%d)\n", this.nCyclesDepositPerFrame, nCyclesPerSecond, nDivisor, this.nFramesPerSecond);
    }

    /**
     * doBurst(nCycles)
     *
     * @this {Time}
     * @param {number} nCycles
     * @return {number} (number of cycles actually executed)
     */
    doBurst(nCycles)
    {
        this.nCyclesBurst = this.nCyclesRemain = nCycles;
        if (!this.aClocks.length) {
            this.nCyclesRemain = 0;
            return this.nCyclesBurst;
        }
        let iClock = 0;
        while (this.nCyclesRemain > 0) {
            if (iClock < this.aClocks.length) {
                let clock = this.aClocks[iClock++];
                nCycles = clock.startClock.call(clock, nCycles) || 1;
            } else {
                iClock = nCycles = 0;
            }
            this.nCyclesRemain -= nCycles;
        }
        return this.nCyclesBurst - this.nCyclesRemain;
    }

    /**
     * doOutside(fn)
     *
     * Use this function to perform any work outside of normal time (eg, DOM updates),
     * to prevent that work from disrupting our speed calculations.
     *
     * @this {Time}
     * @param {function()} fn (should return true only if the function actually performed any work)
     * @return {boolean}
     */
    doOutside(fn)
    {
        let msStart = Date.now();
        if (fn()) {
            let msStop = Date.now();
            this.msOutsideRun += msStop - msStart;
            return true;
        }
        return false;
    }

    /**
     * endBurst(nCycles)
     *
     * @this {Time}
     * @param {number} [nCycles]
     * @return {number} (number of cycles executed in burst)
     */
    endBurst(nCycles = this.nCyclesBurst - this.nCyclesRemain)
    {
        if (!this.fRunning) {
            if (this.nCyclesDeposited) {
                for (let iClock = 0; iClock < this.aClocks.length; iClock++) {
                    let clock = this.aClocks[iClock];
                    clock.stopClock.call(clock);
                }
            }
            this.nCyclesDeposited = nCycles;
        }
        this.nCyclesDeposited -= nCycles;
        if (this.nCyclesDeposited < 1) {
            this.yield();
        }
        this.nCyclesLife += nCycles;
        this.nCyclesRun += nCycles;
        this.nCyclesBurst = this.nCyclesRemain = 0;
        if (!this.fRunning) this.nCyclesRun = 0;
        return nCycles;
    }

    /**
     * getCycles()
     *
     * Returns the number of cycles executed so far.
     *
     * @this {Time}
     * @return {number}
     */
    getCycles()
    {
        let nCyclesClocked = 0;
        for (let iClock = 0; iClock < this.aClocks.length; iClock++) {
            let clock = this.aClocks[iClock];
            nCyclesClocked += clock.getClock.call(clock);
        }
        return this.nCyclesLife + (this.nCyclesBurst - this.nCyclesRemain) + nCyclesClocked;
    }

    /**
     * getCyclesPerMS(ms)
     *
     * If no time period is specified, returns the current number of cycles per second (ie, 1000ms).
     *
     * @this {Time}
     * @param {number} ms (default is 1000)
     * @return {number} number of corresponding cycles
     */
    getCyclesPerMS(ms = 1000)
    {
        return Math.ceil((this.nCyclesPerSecond * this.nCurrentMultiplier) / 1000 * ms);
    }

    /**
     * getCyclesPerRun(fnMinCycles)
     *
     * Returns the number of cycles to execute for the next run.
     *
     * @this {Time}
     * @param {number} [nMinCycles]
     * @return {number} (the maximum number of cycles we should execute in the next burst)
     */
    getCyclesPerRun(nMinCycles = 0)
    {
        let nCycles;
        if (nMinCycles) {
            nCycles = nMinCycles;
            this.nCyclesDeposited += nMinCycles;
        } else {
            nCycles = this.nCyclesDeposited;
            if (nCycles < 1) {
                nCycles = (this.nCyclesDeposited += this.nCyclesDepositPerFrame);
            }
            if (nCycles < 0) {
                this.printf("warning: nCycles dropped below zero: %f\n", nCycles);
                nCycles = this.nCyclesDeposited = 0;
            }
            nCycles |= 0;
            for (let iTimer = this.aTimers.length; iTimer > 0; iTimer--) {
                let timer = this.aTimers[iTimer-1];
                this.assert(!isNaN(timer.nCyclesLeft));
                if (timer.nCyclesLeft < 0) continue;
                if (nCycles > timer.nCyclesLeft) {
                    nCycles = timer.nCyclesLeft;
                }
            }
        }
        return nCycles;
    }

    /**
     * getSpeed(mhz)
     *
     * @this {Time}
     * @param {number} mhz
     * @return {string} the given speed, as a formatted string
     */
    getSpeed(mhz)
    {
        let s;
        if (mhz >= 1) {
            s = mhz.toFixed(2) + "Mhz";
        } else {
            let hz = Math.round(mhz * 1000000);
            if (hz <= 999) {
                s = hz + "Hz";
            } else {
                s = Math.ceil(hz / 1000) + "Khz";
            }
        }
        return s;
    }

    /**
     * getSpeedCurrent()
     *
     * @this {Time}
     * @return {string} the current speed, as a formatted string
     */
    getSpeedCurrent()
    {
        this.printf(MESSAGE.TIME, "getSpeedCurrent(%7.3fhz)\n", this.mhzCurrent * 1000000);
        return (this.fRunning && this.mhzCurrent)? this.getSpeed(this.mhzCurrent) : "Stopped";
    }

    /**
     * getSpeedTarget()
     *
     * @this {Time}
     * @return {string} the target speed, as a formatted string
     */
    getSpeedTarget()
    {
        return this.getSpeed(this.mhzTarget);
    }

    /**
     * isPowered()
     *
     * @this {Time}
     * @return {boolean} true if powered, false if not
     */
    isPowered()
    {
        if (!this.fPowered) {
            this.println("not powered");
            return false;
        }
        return true;
    }

    /**
     * isRunning()
     *
     * @this {Time}
     * @return {boolean}
     */
    isRunning()
    {
        return this.fRunning;
    }

    /**
     * isTimerSet(iTimer)
     *
     * NOTE: Even if the timer is armed, we return false if the clock is currently stopped;
     * in that sense, perhaps this function should be named isTimerArmedAndWillItFireOnTime().
     *
     * @this {Time}
     * @param {number} iTimer
     * @return {boolean}
     */
    isTimerSet(iTimer)
    {
        if (this.fRunning) {
            if (iTimer > 0 && iTimer <= this.aTimers.length) {
                let timer = this.aTimers[iTimer - 1];
                return (timer.nCyclesLeft >= 0);
            }
        }
        return false;
    }

    /**
     * notifyTimers(nCycles)
     *
     * Used by run() to reduce all active timer countdown values by the number of cycles just executed;
     * this is the function that actually "fires" any timer(s) whose countdown has reached (or dropped below)
     * zero, invoking their callback function.
     *
     * @this {Time}
     * @param {number} nCycles (number of cycles actually executed)
     */
    notifyTimers(nCycles)
    {
        if (nCycles >= 1) {
            for (let iTimer = this.aTimers.length; iTimer > 0; iTimer--) {
                let timer = this.aTimers[iTimer-1];
                this.assert(!isNaN(timer.nCyclesLeft));
                if (timer.nCyclesLeft < 0) continue;
                timer.nCyclesLeft -= nCycles;
                if (timer.nCyclesLeft <= 0) {
                    timer.nCyclesLeft = -1; // zero is technically an "active" value, so ensure the timer is dormant now
                    timer.callBack();       // safe to invoke the callback function now
                    if (timer.msAuto >= 0) {
                        this.setTimer(iTimer, timer.msAuto);
                    }
                }
            }
        }
    }

    /**
     * onPower(on)
     *
     * Called by the Machine device to provide notification of a power event.
     *
     * @this {Time}
     * @param {boolean} on (true to power on, false to power off)
     */
    onPower(on)
    {
        this.fPowered = on;
        /*
         * This is also a good time to get access to the Debugger, if any, and add our dump extensions.
         */
        if (this.dbg === undefined) {
            this.dbg = this.findDeviceByClass("Debugger", false);
            if (this.dbg) this.dbg.addDumper(this, "time", "dump time state", this.dumpTime);
        }
    }

    /**
     * onRun()
     *
     * This handles the "run" button, if any, attached to the Time device.
     *
     * Note that this serves a different purpose than the "power" button that's managed by the Input device,
     * because toggling power also requires resetting the program counter prior to start() OR clearing the display
     * after stop().
     *
     * @this {Time}
     */
    onRun()
    {
        if (this.isPowered()) {
            if (this.fRunning) {
                this.stop();
            } else {
                this.start();
            }
        }
    }

    /**
     * onStep(nRepeat)
     *
     * This handles the "step" button, if any, attached to the Time device.
     *
     * @this {Time}
     * @param {number} [nRepeat]
     */
    onStep(nRepeat)
    {
        if (this.isPowered()) {
            if (!this.fRunning) {
                if (this.nStepping) {
                    this.stop();
                } else {
                    this.step(nRepeat);
                }
            } else {
                this.println("already running");
            }
        }
    }

    /**
     * resetSpeed()
     *
     * Resets speed and cycle information as part of any reset() or restore(); this typically occurs during powerUp().
     * It's important that this be called BEFORE the actual restore() call, because restore() may want to call setSpeed(),
     * which in turn assumes that all the cycle counts have been initialized to sensible values.
     *
     * @this {Time}
     */
    resetSpeed()
    {
        this.nCyclesRun = this.nCyclesBurst = this.nCyclesRemain = 0;
        if (!this.setSpeedThrottle()) this.setSpeed(this.nBaseMultiplier);
    }

    /**
     * resetTimers()
     *
     * When the target speed multiplier is altered, it's a good idea to run through all the timers that
     * have a fixed millisecond period and re-arm them, because the timers are using cycle counts that were based
     * on a previous multiplier.
     *
     * @this {Time}
     */
    resetTimers()
    {
        for (let iTimer = this.aTimers.length; iTimer > 0; iTimer--) {
            let timer = this.aTimers[iTimer-1];
            if (timer.msAuto >= 0) this.setTimer(iTimer, timer.msAuto, true);
        }
    }

    /**
     * run(t)
     *
     * This is the callback function we supply to requestAnimationFrame().  The callback has a single
     * DOMHighResTimeStamp argument, which indicates the current time; see performance.now().
     *
     * In the rare case where requestAnimationFrame() has been replaced with setTimeout(), the argument
     * will be undefined.
     *
     * See: https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
     *
     * @this {Time}
     * @param {number} [t]
     */
    run(t)
    {
        this.idAnimationFrame = 0;
        if (!this.fRunning) return;
        this.runCycles();
        for (let i = 0; i < this.aAnimations.length; i++) {
            this.aAnimations[i](t);
        }
        this.idAnimationFrame = this.requestAnimationFrame();
    }

    /**
     * runCycles()
     *
     * @this {Time}
     */
    runCycles()
    {
        this.startRun();
        try {
            this.fYield = false;
            do {
                /*
                 * Execute the burst and then update all timers.
                 */
                this.notifyTimers(this.endBurst(this.doBurst(this.getCyclesPerRun())));
            } while (this.fRunning && !this.fYield);
        }
        catch (err) {
            this.println(err.message);
            this.stop();
        }
        this.stopRun();
    }

    /**
     * setSpeedThrottle()
     *
     * This handles speed adjustments requested by the throttling slider.
     *
     * @this {Time}
     * @return {boolean} (true if a throttle exists, false if not)
     */
    setSpeedThrottle()
    {
        /*
         * We're not going to assume any direct relationship between the slider's min/max/value
         * and our own nCyclesMinimum/nCyclesMaximum/nCyclesPerSecond.  We're just going to calculate
         * a new target nCyclesPerSecond that is proportional, and then convert that to a speed multiplier.
         */
        let elementInput = this.bindings[Time.BINDING.THROTTLE];
        if (elementInput) {
            let ratio = (elementInput.value - elementInput.min) / (elementInput.max - elementInput.min);
            let nCycles = Math.floor((this.nCyclesMaximum - this.nCyclesMinimum) * ratio + this.nCyclesMinimum);
            let nMultiplier = nCycles / this.nCyclesPerSecond;
            this.assert(nMultiplier >= 1);
            this.setSpeed(nMultiplier);
            return true;
        }
        return false;
    }

    /**
     * setSpeed(nMultiplier)
     *
     * @desc Whenever the speed is changed, the running cycle count and corresponding start time must be reset,
     * so that the next effective speed calculation obtains sensible results.  In fact, when run() initially calls
     * setSpeed() with no parameters, that's all this function does (it doesn't change the current speed setting).
     *
     * @this {Time}
     * @param {number} [nMultiplier] is the new proposed multiplier (reverts to default if target was too high)
     * @return {boolean} true if successful, false if not
     */
    setSpeed(nMultiplier)
    {
        let fSuccess = true;
        if (nMultiplier !== undefined) {
            /*
             * If we haven't reached 90% of the current target speed, revert to the default multiplier.
             */
            if (!this.fThrottling && this.mhzCurrent > 0 && this.mhzCurrent < this.mhzTarget * 0.9) {
                nMultiplier = this.nBaseMultiplier;
                fSuccess = false;
            }
            this.nTargetMultiplier = nMultiplier;
            let mhzTarget = this.mhzBase * this.nTargetMultiplier;
            if (this.mhzTarget != mhzTarget) {
                this.mhzTarget = mhzTarget;
                this.setBindingText(Time.BINDING.SPEED, this.getSpeedTarget());
            }
            /*
             * After every run, calcSpeed() will update mhzCurrent, but we also need to be optimistic
             * and set it to the mhzTarget now, so that the next calcSpeed() call will make a reasonable
             * initial estimate.
             */
            this.mhzCurrent = this.mhzTarget;
        }
        this.msStartRun = this.msEndRun = 0;
        this.nCyclesDeposited = this.nCyclesRun = 0;
        this.calcSpeed();       // calculate cycle values for the new target speed
        this.resetTimers();     // and then update all the fixed-period timers using the new cycle multiplier
        return fSuccess;
    }

    /**
     * setTimer(iTimer, ms, fReset)
     *
     * Using the timer index from a previous addTimer() call, this sets that timer to fire
     * after the specified number of milliseconds.
     *
     * @this {Time}
     * @param {number} iTimer
     * @param {number} ms (converted into a cycle countdown internally)
     * @param {boolean} [fReset] (true if the timer should be reset even if already armed)
     * @return {number} (number of cycles used to arm timer, or -1 if error)
     */
    setTimer(iTimer, ms, fReset)
    {
        let nCycles = -1;
        if (iTimer > 0 && iTimer <= this.aTimers.length) {
            let timer = this.aTimers[iTimer-1];
            if (fReset || timer.nCyclesLeft < 0) {
                nCycles = this.getCyclesPerMS(ms);
                /*
                 * If we're currently executing a burst of cycles, the number of cycles executed in the burst
                 * so far must NOT be charged against the cycle timeout we're about to set.  The simplest way to
                 * resolve that is to immediately call endBurst() and bias the cycle timeout by the number of
                 * cycles that the burst executed.
                 */
                if (this.fRunning) {
                    nCycles += this.endBurst();
                }
                timer.nCyclesLeft = nCycles;
            }
        }
        return nCycles;
    }

    /**
     * start()
     *
     * @this {Time}
     * @return {boolean}
     */
    start()
    {
        if (this.fRunning || this.nStepping) {
            return false;
        }

        this.fRunning = true;
        this.msStartRun = this.msEndRun = 0;
        this.update(true);

        this.assert(!this.idAnimationFrame);
        this.idAnimationFrame = this.requestAnimationFrame();
        return true;
    }

    /**
     * step(nRepeat)
     *
     * @this {Time}
     * @param {number} [nRepeat]
     * @return {boolean} true if successful, false if already running
     */
    step(nRepeat = 1)
    {
        if (!this.fRunning) {
            if (nRepeat && !this.nStepping) {
                this.nStepping = nRepeat;
            }
            if (this.nStepping) {
                /*
                 * Execute a minimum-cycle burst and then update all timers.
                 */
                this.nStepping--;
                this.notifyTimers(this.endBurst(this.doBurst(this.getCyclesPerRun(1))));
                this.update(false);
                if (this.nStepping) {
                    let time = this;
                    this.idStepTimeout = setTimeout(function onStepTimeout() {
                        time.step(0);
                    }, 0);
                    return true;
                }
            }
            return true;
        }
        return false;
    }

    /**
     * stop()
     *
     * @this {Time}
     * @return {boolean} true if successful, false if already stopped
     */
    stop()
    {
        if (this.fRunning) {
            this.fRunning = false;
            this.endBurst();
            if (this.idAnimationFrame) {
                this.cancelAnimationFrame(this.idAnimationFrame);
                this.idAnimationFrame = 0;
            }
            this.update(true);
            return true;
        }
        if (this.nStepping) {
            this.nStepping = 0;
            this.update(true);
            return true;
        }
        return false;
    }

    /**
     * startRun()
     *
     * @this {Time}
     */
    startRun()
    {
        this.msOutsideRun = 0;
        this.msStartThisRun = Date.now();
        if (!this.msStartRun) this.msStartRun = this.msStartThisRun;
    }

    /**
     * stopRun()
     *
     * @this {Time}
     */
    stopRun()
    {
        this.msEndRun = Date.now();
        if (this.msOutsideRun) {
            this.msStartRun += this.msOutsideRun;
            this.msStartThisRun += this.msOutsideRun;
        }
        this.calcSpeed(this.nCyclesRun, this.msEndRun - this.msStartRun);
        if (this.msEndRun - this.msLastUpdate >= this.msUpdate) {
            this.update();
            this.msLastUpdate = Date.now();
        }
    }

    /**
     * update(fTransition)
     *
     * Called for periodic updates, single-step updates, and transitional updates from start() and stop().
     *
     * fTransition is set to true by start() and stop() calls, because the machine is transitioning to or from
     * a running state; it is set to false by step() calls, because the machine state changed but it never entered
     * a running state; and it is undefined in all other situations,
     *
     * When we call the update handlers, we set fTransition to true for all of the start(), stop(), and step()
     * cases, because there has been a "transition" in the overall state, just not the running state.
     *
     * @this {Time}
     * @param {boolean} [fTransition]
     */
    update(fTransition)
    {
        if (fTransition) {
            if (this.fRunning) {
                this.println("started with " + this.getSpeedTarget() + " target");
            } else {
                this.println("stopped");
            }
        }

        this.setBindingText(Time.BINDING.RUN, this.fRunning? "Halt" : "Run");
        this.setBindingText(Time.BINDING.STEP, this.nStepping? "Stop" : "Step");

        if (!this.fThrottling) {
            this.setBindingText(Time.BINDING.SPEED, this.getSpeedCurrent());
        }

        for (let i = 0; i < this.aUpdates.length; i++) {
            let device = this.aUpdates[i];
            device.onUpdate.call(device, fTransition != undefined);
        }
        this.yield();
    }

    /**
     * yield()
     *
     * @this {Time}
     */
    yield()
    {
        this.fYield = true;
    }

    /**
     * dumpTime(values)
     *
     * @this {Time}
     * @param {Array.<number>} values (the Debugger passes along any values on the command-line, but we don't use them)
     */
    dumpTime(values)
    {
        let sDump = "";
        sDump += this.sprintf("nCyclesDeposited: %f\n", this.nCyclesDeposited);
        sDump += this.sprintf("nCyclesDepositPerFrame: %f\n", this.nCyclesDepositPerFrame);
        sDump += this.sprintf("nCyclesPerSecond: %f\n", this.nCyclesPerSecond);
        return sDump;
    }
}

Time.BINDING = {
    RUN:        "run",
    SPEED:      "speed",
    STEP:       "step",
    THROTTLE:   "throttle"
};

Defs.CLASSES["Time"] = Time;
