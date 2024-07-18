/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode'
import { BuildSystem, FolderInfo, transformByQState } from '../../models/model'
import { getLogger } from '../../../shared/logger'
import * as CodeWhispererConstants from '../../models/constants'
import { spawnSync } from 'child_process' // Consider using ChildProcess once we finalize all spawnSync calls
import { CodeTransformMavenBuildCommand, telemetry } from '../../../shared/telemetry/telemetry'
import { CodeTransformTelemetryState } from '../../../amazonqGumby/telemetry/codeTransformTelemetryState'
import { MetadataResult } from '../../../shared/telemetry/telemetryClient'
import { ToolkitError } from '../../../shared/errors'
import { writeLogs } from './transformFileHandler'
import { throwIfCancelled } from './transformApiHandler'
import { globals } from '../../../shared'
import * as os from 'os'

// run 'install' with either 'mvnw.cmd', './mvnw', or 'mvn' (if wrapper exists, we use that, otherwise we use regular 'mvn')
function installMavenProjectDependencies(dependenciesFolder: FolderInfo, modulePath: string) {
    // baseCommand will be one of: '.\mvnw.cmd', './mvnw', 'mvn'
    const baseCommand = transformByQState.getBuildSystemCommand()

    transformByQState.appendToLocalBuildErrorLog(`Running command ${baseCommand} clean install`)

    // Note: IntelliJ runs 'clean' separately from 'install'. Evaluate benefits (if any) of this.
    const args = [`-Dmaven.repo.local=${dependenciesFolder.path}`, 'clean', 'install', '-q']
    let environment = process.env

    if (transformByQState.getJavaHome() !== undefined) {
        environment = { ...process.env, JAVA_HOME: transformByQState.getJavaHome() }
    }

    const argString = args.join(' ')
    const spawnResult = spawnSync(baseCommand, args, {
        cwd: modulePath,
        shell: true,
        encoding: 'utf-8',
        env: environment,
        maxBuffer: CodeWhispererConstants.maxBufferSize,
    })

    if (spawnResult.status !== 0) {
        let errorLog = ''
        errorLog += spawnResult.error ? JSON.stringify(spawnResult.error) : ''
        errorLog += `${spawnResult.stderr}\n${spawnResult.stdout}`
        transformByQState.appendToLocalBuildErrorLog(`${baseCommand} ${argString} failed: \n ${errorLog}`)
        getLogger().error(
            `CodeTransformation: Error in running Maven ${argString} command ${baseCommand} = ${errorLog}`
        )
        let errorReason = ''
        if (spawnResult.stdout) {
            errorReason = `Maven ${argString}: InstallationExecutionError`
            /*
             * adding this check here because these mvn commands sometimes generate a lot of output.
             * rarely, a buffer overflow has resulted when these mvn commands are run with -X, -e flags
             * which are not being used here (for now), but still keeping this just in case.
             */
            if (Buffer.byteLength(spawnResult.stdout, 'utf-8') > CodeWhispererConstants.maxBufferSize) {
                errorReason += '-BufferOverflow'
            }
        } else {
            errorReason = `Maven ${argString}: InstallationSpawnError`
        }
        if (spawnResult.error) {
            const errorCode = (spawnResult.error as any).code ?? 'UNKNOWN'
            errorReason += `-${errorCode}`
        }
        let mavenBuildCommand = transformByQState.getBuildSystemCommand()
        // slashes not allowed in telemetry
        if (mavenBuildCommand === './mvnw') {
            mavenBuildCommand = 'mvnw'
        } else if (mavenBuildCommand === '.\\mvnw.cmd') {
            mavenBuildCommand = 'mvnw.cmd'
        }
        telemetry.codeTransform_mvnBuildFailed.emit({
            codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
            codeTransformMavenBuildCommand: mavenBuildCommand as CodeTransformMavenBuildCommand,
            result: MetadataResult.Fail,
            reason: errorReason,
        })
        throw new ToolkitError(`Maven ${argString} error`, { code: 'MavenExecutionError' })
    } else {
        transformByQState.appendToLocalBuildErrorLog(`${baseCommand} ${argString} succeeded`)
    }
}

function copyMavenProjectDependencies(dependenciesFolder: FolderInfo, modulePath: string) {
    // baseCommand will be one of: '.\mvnw.cmd', './mvnw', 'mvn'
    const baseCommand = transformByQState.getBuildSystemCommand()

    transformByQState.appendToLocalBuildErrorLog(`Running command ${baseCommand} copy-dependencies`)

    const args = [
        'dependency:copy-dependencies',
        `-DoutputDirectory=${dependenciesFolder.path}`,
        '-Dmdep.useRepositoryLayout=true',
        '-Dmdep.copyPom=true',
        '-Dmdep.addParentPoms=true',
        '-q',
    ]
    let environment = process.env
    // if JAVA_HOME not found or not matching project JDK, get user input for it and set here
    if (transformByQState.getJavaHome() !== undefined) {
        environment = { ...process.env, JAVA_HOME: transformByQState.getJavaHome() }
    }
    const spawnResult = spawnSync(baseCommand, args, {
        cwd: modulePath,
        shell: true,
        encoding: 'utf-8',
        env: environment,
        maxBuffer: CodeWhispererConstants.maxBufferSize,
    })
    if (spawnResult.status !== 0) {
        let errorLog = ''
        errorLog += spawnResult.error ? JSON.stringify(spawnResult.error) : ''
        errorLog += `${spawnResult.stderr}\n${spawnResult.stdout}`
        transformByQState.appendToLocalBuildErrorLog(`${baseCommand} copy-dependencies failed: \n ${errorLog}`)
        getLogger().info(
            `CodeTransformation: Maven copy-dependencies command ${baseCommand} failed, but still continuing with transformation: ${errorLog}`
        )
        let errorReason = ''
        if (spawnResult.stdout) {
            errorReason = 'Maven Copy: CopyDependenciesExecutionError'
            if (Buffer.byteLength(spawnResult.stdout, 'utf-8') > CodeWhispererConstants.maxBufferSize) {
                errorReason += '-BufferOverflow'
            }
        } else {
            errorReason = 'Maven Copy: CopyDependenciesSpawnError'
        }
        if (spawnResult.error) {
            const errorCode = (spawnResult.error as any).code ?? 'UNKNOWN'
            errorReason += `-${errorCode}`
        }
        let mavenBuildCommand = transformByQState.getBuildSystemCommand()
        // slashes not allowed in telemetry
        if (mavenBuildCommand === './mvnw') {
            mavenBuildCommand = 'mvnw'
        } else if (mavenBuildCommand === '.\\mvnw.cmd') {
            mavenBuildCommand = 'mvnw.cmd'
        }
        telemetry.codeTransform_mvnBuildFailed.emit({
            codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
            codeTransformMavenBuildCommand: mavenBuildCommand as CodeTransformMavenBuildCommand,
            result: MetadataResult.Fail,
            reason: errorReason,
        })
        throw new Error('Maven copy-deps error')
    } else {
        transformByQState.appendToLocalBuildErrorLog(`${baseCommand} copy-dependencies succeeded`)
    }
}

export async function prepareProjectDependencies(dependenciesFolder: FolderInfo | undefined, projectPath: string) {
    // at this point, one of these must be true
    if (transformByQState.getBuildSystem() === BuildSystem.Maven) {
        // dependenciesFolder always exists for Maven
        await prepareMavenProjectDependencies(dependenciesFolder!, projectPath)
    } else if (transformByQState.getBuildSystem() === BuildSystem.Gradle) {
        try {
            await prepareGradleProjectDependencies()
        } catch (err) {
            getLogger().info('CodeTransformation: gradle_copy_deps.py failed, terminating the transformation job')
            throw err
        }
    }
}

export async function prepareMavenProjectDependencies(dependenciesFolder: FolderInfo, projectPath: string) {
    try {
        copyMavenProjectDependencies(dependenciesFolder, projectPath)
    } catch (err) {
        // continue in case of errors
        getLogger().info(
            `CodeTransformation: Maven copy-dependencies failed, but transformation will continue and may succeed`
        )
    }

    try {
        installMavenProjectDependencies(dependenciesFolder, projectPath)
    } catch (err) {
        void vscode.window.showErrorMessage(CodeWhispererConstants.cleanInstallErrorNotification)
        // open build-logs.txt file to show user error logs
        const logFilePath = await writeLogs()
        const doc = await vscode.workspace.openTextDocument(logFilePath)
        await vscode.window.showTextDocument(doc)
        throw err
    }

    throwIfCancelled()
    void vscode.window.showInformationMessage(CodeWhispererConstants.buildSucceededNotification)
}

async function getPythonExecutable() {
    const pythonExecutables = ['python', 'python3', 'py', 'py3']
    for (const executable of pythonExecutables) {
        try {
            const result = spawnSync(executable, ['--version'])
            if (result.status === 0) {
                return executable
            }
        } catch (err) {
            // ignore errors and try another executable
        }
    }
    return undefined
}

export async function prepareGradleProjectDependencies() {
    try {
        transformByQState.appendToLocalBuildErrorLog(`Running gradle_copy_deps.py to copy Gradle project dependencies`)
        let scriptPath = globals.context.asAbsolutePath('scripts/build/transformByQ/gradle_copy_deps.py')
        if (os.platform() === 'win32') {
            scriptPath = globals.context.asAbsolutePath('scripts/build/transformByQ/windows_gradle_copy_deps.py')
        }
        const args = [`${scriptPath}`, `${transformByQState.getProjectPath()}`]
        let environment = process.env
        if (transformByQState.getJavaHome() !== undefined) {
            environment = { ...process.env, JAVA_HOME: transformByQState.getJavaHome() }
        }

        const pythonExecutable = await getPythonExecutable()
        if (!pythonExecutable) {
            const errorMessage =
                'No Python executable found (checked python, python3, py, and py3). Please install Python and try again.'
            transformByQState.appendToLocalBuildErrorLog(errorMessage)
            getLogger().error(errorMessage)
            throw new Error(errorMessage)
        }

        const buildSystemCommand = transformByQState.getBuildSystemCommand() // can be ./gradlew, .\gradlew.bat, or gradle
        if (buildSystemCommand === 'gradle') {
            // means Gradle wrapper not present in project, try to create it
            const spawnResult = spawnSync('gradle', ['wrapper'], {
                cwd: transformByQState.getProjectPath(),
                shell: true,
                encoding: 'utf-8',
                env: environment,
                maxBuffer: CodeWhispererConstants.maxBufferSize,
            })
            if (spawnResult.status !== 0) {
                const errorMessage = `Failed to create Gradle wrapper:\n\n${spawnResult.stderr}\n\n${spawnResult.stdout}\n\nEnsure a Gradle wrapper is present in your project before retrying. You should ensure you have Gradle installed by running gradle -v, then run gradle wrapper to generate the wrapper.`
                transformByQState.appendToLocalBuildErrorLog(errorMessage)
                getLogger().error(errorMessage)
                throw new Error(errorMessage)
            }
        }

        // shell: false because project path is passed as an arg to the Python script
        // and any special characters in that path will be interpreted by the shell
        const spawnResult = spawnSync(pythonExecutable, args, {
            cwd: transformByQState.getProjectPath(),
            shell: false,
            encoding: 'utf-8',
            env: environment,
            maxBuffer: CodeWhispererConstants.maxBufferSize,
        })

        const argString = args.join(' ')
        if (spawnResult.status !== 0) {
            let errorLog = ''
            errorLog += spawnResult.error ? JSON.stringify(spawnResult.error) : ''
            errorLog += `${spawnResult.stderr}\n${spawnResult.stdout}`
            transformByQState.appendToLocalBuildErrorLog(`gradle_copy_deps.py failed: \n ${errorLog}`)
            getLogger().error(`CodeTransformation: Error in running gradle_copy_deps.py = ${errorLog}`)
            let errorReason = ''
            if (spawnResult.stdout) {
                errorReason = `Python ${argString}: ExecutionError`
                // in case buffer overflows because this script may generate a lot of output
                if (Buffer.byteLength(spawnResult.stdout, 'utf-8') > CodeWhispererConstants.maxBufferSize) {
                    errorReason += '-BufferOverflow'
                }
            } else {
                errorReason = `Python ${argString}: SpawnError`
            }
            if (spawnResult.error) {
                const errorCode = (spawnResult.error as any).code ?? 'UNKNOWN'
                errorReason += `-${errorCode}`
            }
            let gradleBuildCommand = transformByQState.getBuildSystemCommand()
            // slashes not allowed in telemetry
            if (gradleBuildCommand === './gradlew') {
                gradleBuildCommand = 'gradlew'
            } else if (gradleBuildCommand === '.\\gradlew.bat') {
                gradleBuildCommand = 'gradlew.bat'
            }
            // TO-DO: move this in the finally block, use the new `codeTransform_build` metric, and use status code to decide result
            telemetry.codeTransform_mvnBuildFailed.emit({
                codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
                codeTransformMavenBuildCommand: gradleBuildCommand as CodeTransformMavenBuildCommand,
                result: MetadataResult.Fail,
                reason: errorReason,
            })
            throw new Error(`gradle_copy_deps.py failed`)
        } else {
            transformByQState.appendToLocalBuildErrorLog(`gradle_copy_deps.py succeeded: ${spawnResult.stdout}`)
        }
    } catch (err) {
        void vscode.window.showErrorMessage(CodeWhispererConstants.gradleBuildErrorNotification)
        // open build-logs.txt file to show user error logs
        const logFilePath = await writeLogs()
        const doc = await vscode.workspace.openTextDocument(logFilePath)
        await vscode.window.showTextDocument(doc)
        throw err
    }
    throwIfCancelled()
    void vscode.window.showInformationMessage(CodeWhispererConstants.buildSucceededNotification)
}

export async function getVersionData() {
    const baseCommand = transformByQState.getBuildSystemCommand() // will be one of: '.\mvnw.cmd', './mvnw', 'mvn', '.\gradlew.bat', './gradlew', 'gradle'
    const modulePath = transformByQState.getProjectPath()
    const args = ['-v']
    const spawnResult = spawnSync(baseCommand, args, { cwd: modulePath, shell: true, encoding: 'utf-8' })
    let localBuildSystemVersion: string | undefined = ''
    let localJavaVersion: string | undefined = ''
    if (transformByQState.getBuildSystem() === BuildSystem.Maven) {
        try {
            const localMavenVersionIndex = spawnResult.stdout.indexOf('Apache Maven ')
            const localMavenVersionString = spawnResult.stdout.slice(localMavenVersionIndex + 13).trim()
            localBuildSystemVersion = localMavenVersionString.slice(0, localMavenVersionString.indexOf(' ')).trim()
        } catch (e: any) {
            localBuildSystemVersion = undefined // if this happens here or below, user most likely has JAVA_HOME incorrectly defined
        }

        try {
            const localJavaVersionIndex = spawnResult.stdout.indexOf('Java version: ')
            const localJavaVersionString = spawnResult.stdout.slice(localJavaVersionIndex + 14).trim()
            localJavaVersion = localJavaVersionString.slice(0, localJavaVersionString.indexOf(',')).trim() // will match value of JAVA_HOME
        } catch (e: any) {
            localJavaVersion = undefined
        }
    } else if (transformByQState.getBuildSystem() === BuildSystem.Gradle) {
        try {
            const localGradleVersionIndex = spawnResult.stdout.indexOf('Gradle ')
            const localGradleVersionString = spawnResult.stdout.slice(localGradleVersionIndex + 7).trim()
            localBuildSystemVersion = localGradleVersionString.slice(0, localGradleVersionString.indexOf('\n')).trim()
        } catch (e: any) {
            localBuildSystemVersion = undefined // if this happens here or below, user most likely has JAVA_HOME incorrectly defined
        }

        try {
            const localJavaVersionIndex = spawnResult.stdout.indexOf('JVM: ')
            const localJavaVersionString = spawnResult.stdout.slice(localJavaVersionIndex + 5).trim()
            localJavaVersion = localJavaVersionString.slice(0, localJavaVersionString.indexOf(' ')).trim() // will match value of JAVA_HOME
        } catch (e: any) {
            localJavaVersion = undefined
        }
    }
    getLogger().info(
        `CodeTransformation: Ran ${baseCommand} -v to get build system version = ${localBuildSystemVersion} and Java version = ${localJavaVersion} with project JDK = ${transformByQState.getSourceJDKVersion()}`
    )
    return [localBuildSystemVersion, localJavaVersion]
}

// run maven 'versions:dependency-updates-aggregate-report' with either 'mvnw.cmd', './mvnw', or 'mvn' (if wrapper exists, we use that, otherwise we use regular 'mvn')
export function runMavenDependencyUpdateCommands(dependenciesFolder: FolderInfo) {
    // baseCommand will be one of: '.\mvnw.cmd', './mvnw', 'mvn'
    const baseCommand = transformByQState.getBuildSystemCommand() // will be one of: '.\mvnw.cmd', './mvnw', 'mvn'

    // Note: IntelliJ runs 'clean' separately from 'install'. Evaluate benefits (if any) of this.
    const args = [
        'versions:dependency-updates-aggregate-report',
        `-DoutputDirectory=${dependenciesFolder.path}`,
        '-DonlyProjectDependencies=true',
        '-DdependencyUpdatesReportFormats=xml',
    ]

    let environment = process.env
    // if JAVA_HOME not found or not matching project JDK, get user input for it and set here
    if (transformByQState.getJavaHome() !== undefined) {
        environment = { ...process.env, JAVA_HOME: transformByQState.getJavaHome() }
    }

    const spawnResult = spawnSync(baseCommand, args, {
        // default behavior is looks for pom.xml in this root
        cwd: dependenciesFolder.path,
        shell: true,
        encoding: 'utf-8',
        env: environment,
        maxBuffer: CodeWhispererConstants.maxBufferSize,
    })

    if (spawnResult.status !== 0) {
        throw new Error(spawnResult.stderr)
    } else {
        return spawnResult.stdout
    }
}
