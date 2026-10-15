import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLocation,
  parseFrameText,
  parseExceptionHeader,
  parseStackTrace,
  classifyFrame,
  detectDatabaseException,
  identifyRootCause
} from '../src/public/admin-developer-tools-stack-analyzer.js';

test('Stack Trace Analyzer - Location & Frame Parsing', async (t) => {

  await t.test('parseLocation should decode file names and line numbers', () => {
    assert.deepEqual(parseLocation('MyClass.java:23'), { fileName: 'MyClass.java', lineNumber: 23 });
    assert.deepEqual(parseLocation('Native Method'), { fileName: 'Native Method', lineNumber: null });
    assert.deepEqual(parseLocation('Unknown Source'), { fileName: 'Unknown Source', lineNumber: null });
    assert.deepEqual(parseLocation('MyClass.java'), { fileName: 'MyClass.java', lineNumber: null });
  });

  await t.test('parseFrameText should correctly extract Java frame elements', () => {
    const frame = parseFrameText('at com.example.MyClass.myMethod(MyClass.java:23)');
    assert.equal(frame.fullClassName, 'com.example.MyClass');
    assert.equal(frame.methodName, 'myMethod');
    assert.equal(frame.fileName, 'MyClass.java');
    assert.equal(frame.lineNumber, 23);
    assert.equal(frame.gosuFile, null);
  });

  await t.test('parseFrameText should extract Gosu framework file references', () => {
    const frame = parseFrameText('at gw.lang.function.Function0.invoke(Function0.js) (Gosu file: MyGosuClass.gs:12)');
    assert.equal(frame.fullClassName, 'gw.lang.function.Function0');
    assert.equal(frame.methodName, 'invoke');
    assert.equal(frame.fileName, 'Function0.js');
    assert.equal(frame.lineNumber, null);
    assert.equal(frame.gosuFile, 'MyGosuClass.gs');
    assert.equal(frame.gosuLine, 12);
  });

  await t.test('parseFrameText should handle frames with missing source or line information', () => {
    const frame = parseFrameText('at com.example.MyClass.myMethod(Unknown Source)');
    assert.equal(frame.fullClassName, 'com.example.MyClass');
    assert.equal(frame.methodName, 'myMethod');
    assert.equal(frame.fileName, 'Unknown Source');
    assert.equal(frame.lineNumber, null);
  });
});

test('Stack Trace Analyzer - Exception Header & Multi-Cause Parsing', async (t) => {

  await t.test('parseExceptionHeader should parse simple class with message', () => {
    const header = parseExceptionHeader('java.lang.NullPointerException: Cannot invoke method');
    assert.equal(header.exceptionClass, 'java.lang.NullPointerException');
    assert.equal(header.message, 'Cannot invoke method');
  });

  await t.test('parseExceptionHeader should handle exceptions with no message', () => {
    const header = parseExceptionHeader('java.lang.NullPointerException');
    assert.equal(header.exceptionClass, 'java.lang.NullPointerException');
    assert.equal(header.message, '');
  });

  await t.test('parseStackTrace should parse simple Java exceptions', () => {
    const trace = `java.lang.IllegalArgumentException: Invalid parameter
    at com.example.App.run(App.java:10)
    at com.example.App.main(App.java:5)`;

    const parsed = parseStackTrace(trace);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].exceptionClass, 'java.lang.IllegalArgumentException');
    assert.equal(parsed[0].message, 'Invalid parameter');
    assert.equal(parsed[0].frames.length, 2);
    assert.equal(parsed[0].frames[0].fullClassName, 'com.example.App');
    assert.equal(parsed[0].frames[0].lineNumber, 10);
  });

  await t.test('parseStackTrace should parse nested Caused by chains', () => {
    const trace = `com.guidewire.pl.web.controller.UserDisplayException: Page processing failed
    at com.guidewire.pl.web.controller.RequestProcessor.process(RequestProcessor.java:99)
Caused by: java.lang.NullPointerException: Object was null
    at com.customer.rules.CustomRule.evaluate(CustomRule.java:12)
    ... 10 more`;

    const parsed = parseStackTrace(trace);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].exceptionClass, 'com.guidewire.pl.web.controller.UserDisplayException');
    assert.equal(parsed[1].exceptionClass, 'java.lang.NullPointerException');
    assert.equal(parsed[1].frames.length, 1);
    assert.equal(parsed[1].omittedCount, 10);
  });

  await t.test('parseStackTrace should handle malformed or incomplete stack traces gracefully', () => {
    const malformed = `Some random console output that is not a trace
    but contains some arbitrary words like at and caused by without headers`;
    const parsed = parseStackTrace(malformed);
    // Should still treat the first line as a generic header and parse nothing as frames
    assert.ok(parsed.length > 0);
    assert.equal(parsed[0].frames.length, 0);
  });
});

test('Stack Trace Analyzer - Frame Classification & Target Analysis', async (t) => {

  await t.test('classifyFrame should categorize frames into correct groups', () => {
    const gosuFrame = { fullClassName: 'gw.rules.PolicyRules', fileName: 'PolicyRules.gs', lineNumber: 45 };
    assert.equal(classifyFrame(gosuFrame), 'custom-gosu');

    const gwFrame = { fullClassName: 'com.guidewire.pl.web.controller.RequestProcessor', fileName: 'RequestProcessor.java' };
    assert.equal(classifyFrame(gwFrame), 'guidewire-framework');

    const jdkFrame = { fullClassName: 'java.lang.String', fileName: 'String.java' };
    assert.equal(classifyFrame(jdkFrame), 'framework-noise');

    const customAppFrame = { fullClassName: 'com.customer.integration.AddressValidator', fileName: 'AddressValidator.java' };
    assert.equal(classifyFrame(customAppFrame), 'custom-app');
  });

  await t.test('detectDatabaseException should identify SQL related errors in a chain', () => {
    const exceptions = [
      { exceptionClass: 'com.guidewire.commons.system.exception.DatabaseException', message: 'DB Error', frames: [] },
      { exceptionClass: 'java.sql.SQLException', message: 'ORA-00060 Deadlock', frames: [] }
    ];
    const detected = detectDatabaseException(exceptions);
    assert.ok(detected);
    assert.equal(detected.exceptionClass, 'com.guidewire.commons.system.exception.DatabaseException');
  });

  await t.test('identifyRootCause should correctly pinpoint the deepest exception', () => {
    const exceptions = [
      { exceptionClass: 'com.guidewire.Exception', message: 'Wrapper', frames: [] },
      { exceptionClass: 'java.lang.NullPointerException', message: 'Root cause', frames: [{}] }
    ];
    const root = identifyRootCause(exceptions);
    assert.equal(root.exceptionClass, 'java.lang.NullPointerException');
    assert.equal(root.depth, 1);
    assert.equal(root.hasFrames, true);
  });
});
