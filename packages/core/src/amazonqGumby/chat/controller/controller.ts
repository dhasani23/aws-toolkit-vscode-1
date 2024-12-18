/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * This class is responsible for responding to UI events by calling
 * the Gumby extension.
 */
import fs from 'fs'
import path from 'path'
import * as vscode from 'vscode'
import { GumbyNamedMessages, Messenger } from './messenger/messenger'
import { AuthController } from '../../../amazonq/auth/controller'
import { ChatSessionManager } from '../storages/chatSession'
import { ConversationState, Session } from '../session/session'
import { getLogger } from '../../../shared/logger'
import { featureName } from '../../models/constants'
import { AuthUtil } from '../../../codewhisperer/util/authUtil'
import {
    cleanupTransformationJob,
    compileProject,
    finishHumanInTheLoop,
    getValidCandidateProjects,
    openBuildLogFile,
    openHilPomFile,
    postTransformationJob,
    processTransformFormInput,
    startTransformByQ,
    validateCanCompileProject,
} from '../../../codewhisperer/commands/startTransformByQ'
import {
    BuildSystem,
    JDKVersion,
    TransformationCandidateProject,
    transformByQState,
} from '../../../codewhisperer/models/model'
import {
    AlternateDependencyVersionsNotFoundError,
    JavaHomeNotSetError,
    JobStartError,
    ModuleUploadError,
    NoJavaProjectsFoundError,
    NoMavenOrGradleJavaProjectsFoundError,
    TransformationPreBuildError,
} from '../../errors'
import * as CodeWhispererConstants from '../../../codewhisperer/models/constants'
import MessengerUtils, { ButtonActions, GumbyCommands } from './messenger/messengerUtils'
import { CancelActionPositions } from '../../telemetry/codeTransformTelemetry'
import { openUrl } from '../../../shared/utilities/vsCodeUtils'
import { telemetry, CodeTransformBuildSystem } from '../../../shared/telemetry/telemetry'
import { MetadataResult } from '../../../shared/telemetry/telemetryClient'
import { CodeTransformTelemetryState } from '../../telemetry/codeTransformTelemetryState'
import { getAuthType, stopTransformByQ } from '../../../codewhisperer/service/transformByQ/transformApiHandler'
import DependencyVersions from '../../models/dependencies'
import { checkBuildSystem } from '../../../codewhisperer/service/transformByQ/transformFileHandler'
// These events can be interactions within the chat or elsewhere in the IDE
export interface ChatControllerEventEmitters {
    readonly transformSelected: vscode.EventEmitter<any>
    readonly tabOpened: vscode.EventEmitter<any>
    readonly tabClosed: vscode.EventEmitter<any>
    readonly authClicked: vscode.EventEmitter<any>
    readonly formActionClicked: vscode.EventEmitter<any>
    readonly commandSentFromIDE: vscode.EventEmitter<any>
    readonly transformationFinished: vscode.EventEmitter<any>
    readonly processHumanChatMessage: vscode.EventEmitter<any>
    readonly linkClicked: vscode.EventEmitter<any>
    readonly humanInTheLoopStartIntervention: vscode.EventEmitter<any>
    readonly humanInTheLoopPromptUserForDependency: vscode.EventEmitter<any>
    readonly humanInTheLoopSelectionUploaded: vscode.EventEmitter<any>
    readonly errorThrown: vscode.EventEmitter<any>
}

export class GumbyController {
    private readonly messenger: Messenger
    private readonly sessionStorage: ChatSessionManager
    private authController: AuthController

    public constructor(
        private readonly chatControllerMessageListeners: ChatControllerEventEmitters,
        messenger: Messenger,
        onDidChangeAmazonQVisibility: vscode.Event<boolean>
    ) {
        this.messenger = messenger
        this.sessionStorage = ChatSessionManager.Instance
        this.authController = new AuthController()

        this.chatControllerMessageListeners.transformSelected.event(data => {
            return this.transformInitiated(data)
        })

        this.chatControllerMessageListeners.tabOpened.event(data => {
            return this.tabOpened(data)
        })

        this.chatControllerMessageListeners.tabClosed.event(data => {
            return this.tabClosed(data)
        })

        this.chatControllerMessageListeners.authClicked.event(data => {
            this.authClicked(data)
        })

        this.chatControllerMessageListeners.commandSentFromIDE.event(data => {
            return this.commandSentFromIDE(data)
        })

        this.chatControllerMessageListeners.formActionClicked.event(data => {
            return this.formActionClicked(data)
        })

        this.chatControllerMessageListeners.transformationFinished.event(data => {
            return this.transformationFinished(data)
        })

        this.chatControllerMessageListeners.processHumanChatMessage.event(data => {
            return this.processHumanChatMessage(data)
        })

        this.chatControllerMessageListeners.linkClicked.event(data => {
            this.openLink(data)
        })

        this.chatControllerMessageListeners.humanInTheLoopStartIntervention.event(data => {
            return this.startHILIntervention(data)
        })

        this.chatControllerMessageListeners.humanInTheLoopPromptUserForDependency.event(data => {
            return this.HILPromptForDependency(data)
        })

        this.chatControllerMessageListeners.humanInTheLoopSelectionUploaded.event(data => {
            return this.HILDependencySelectionUploaded(data)
        })

        this.chatControllerMessageListeners.errorThrown.event(data => {
            return this.handleError(data)
        })
    }

    private async tabOpened(message: any) {
        const session: Session = this.sessionStorage.getSession()
        const tabID = this.sessionStorage.setActiveTab(message.tabID)

        // check if authentication has expired
        try {
            getLogger().debug(`${featureName}: Session created with id: ${session.tabID}`)

            const authState = await AuthUtil.instance.getChatAuthState()
            if (authState.amazonQ !== 'connected') {
                void this.messenger.sendAuthNeededExceptionMessage(authState, tabID)
                session.isAuthenticating = true
                return
            }
        } catch (err: any) {
            this.messenger.sendErrorMessage(err.message, message.tabID)
        }
    }

    private async tabClosed(data: any) {
        this.sessionStorage.removeActiveTab()
    }

    private authClicked(message: any) {
        this.authController.handleAuth(message.authType)

        this.messenger.sendAnswer({
            type: 'answer',
            tabID: message.tabID,
            message: 'Follow instructions to re-authenticate ...',
        })

        // Explicitly ensure the user goes through the re-authenticate flow
        this.messenger.sendChatInputEnabled(message.tabID, false)
    }

    private commandSentFromIDE(data: any): any {
        this.messenger.sendCommandMessage(data)
    }

    private async transformInitiated(message: any) {
        // check that a project is open
        const workspaceFolders = vscode.workspace.workspaceFolders
        if (workspaceFolders === undefined || workspaceFolders.length === 0) {
            this.messenger.sendUnrecoverableErrorResponse('no-project-found', message.tabID)
            return
        }

        // check that the session is authenticated
        const session: Session = this.sessionStorage.getSession()
        try {
            const authState = await AuthUtil.instance.getChatAuthState()
            if (authState.amazonQ !== 'connected') {
                void this.messenger.sendAuthNeededExceptionMessage(authState, message.tabID)
                session.isAuthenticating = true
                return
            }

            switch (this.sessionStorage.getSession().conversationState) {
                case ConversationState.JOB_SUBMITTED:
                    this.messenger.sendAsyncEventProgress(
                        message.tabID,
                        true,
                        undefined,
                        GumbyNamedMessages.JOB_SUBMISSION_STATUS_MESSAGE
                    )
                    this.messenger.sendJobSubmittedMessage(message.tabID)
                    return
                case ConversationState.COMPILING:
                    this.messenger.sendAsyncEventProgress(
                        message.tabID,
                        true,
                        undefined,
                        GumbyNamedMessages.COMPILATION_PROGRESS_MESSAGE
                    )
                    this.messenger.sendCompilationInProgress(message.tabID)
                    return
            }
            CodeTransformTelemetryState.instance.setSessionId()
            this.messenger.sendTransformationIntroduction(message.tabID)

            // start /transform chat flow
            const validProjects = await this.validateProjectsWithReplyOnError(message)
            if (validProjects.length > 0) {
                this.sessionStorage.getSession().updateCandidateProjects(validProjects)
                await this.messenger.sendProjectPrompt(validProjects, message.tabID)
            }
        } catch (err: any) {
            // if there was an issue getting the list of valid projects, the error message will be shown here
            this.messenger.sendErrorMessage(err.message, message.tabID)
        }
    }

    private async validateProjectsWithReplyOnError(message: any): Promise<TransformationCandidateProject[]> {
        try {
            const validProjects = await getValidCandidateProjects()
            return validProjects
        } catch (err: any) {
            if (err instanceof NoJavaProjectsFoundError) {
                this.messenger.sendUnrecoverableErrorResponse('no-java-project-found', message.tabID)
            } else if (err instanceof NoMavenOrGradleJavaProjectsFoundError) {
                this.messenger.sendUnrecoverableErrorResponse('no-maven-or-gradle-java-project-found', message.tabID)
            } else {
                this.messenger.sendUnrecoverableErrorResponse('no-project-found', message.tabID)
            }
        }
        return []
    }

    private async formActionClicked(message: any) {
        const typedAction = MessengerUtils.stringToEnumValue(ButtonActions, message.action as any)
        switch (typedAction) {
            case ButtonActions.CONFIRM_TRANSFORMATION_FORM:
                await this.initiateTransformationOnProject(message)
                break
            case ButtonActions.CANCEL_TRANSFORMATION_FORM:
                this.messenger.sendJobFinishedMessage(message.tabID, CodeWhispererConstants.jobCancelledChatMessage)
                break
            case ButtonActions.CONFIRM_BUILD_SYSTEM_FORM:
                await this.handleBuildSystemForm(message)
                break
            case ButtonActions.CANCEL_BUILD_SYSTEM_FORM:
                this.messenger.sendJobFinishedMessage(message.tabID, CodeWhispererConstants.jobCancelledChatMessage)
                break
            case ButtonActions.VIEW_TRANSFORMATION_HUB:
                await vscode.commands.executeCommand(GumbyCommands.FOCUS_TRANSFORMATION_HUB, CancelActionPositions.Chat)
                this.messenger.sendJobSubmittedMessage(message.tabID)
                break
            case ButtonActions.STOP_TRANSFORMATION_JOB:
                await stopTransformByQ(transformByQState.getJobId(), CancelActionPositions.Chat)
                await postTransformationJob()
                await cleanupTransformationJob()
                break
            case ButtonActions.CONFIRM_START_TRANSFORMATION_FLOW:
                this.resetTransformationChatFlow()
                this.messenger.sendCommandMessage({ ...message, command: GumbyCommands.CLEAR_CHAT })
                await this.transformInitiated(message)
                break
            case ButtonActions.CONFIRM_DEPENDENCY_FORM:
                await this.continueJobWithSelectedDependency(message)
                break
            case ButtonActions.CANCEL_DEPENDENCY_FORM:
                this.messenger.sendUserPrompt('Cancel', message.tabID)
                await this.continueTransformationWithoutHIL(message)
                break
            case ButtonActions.OPEN_FILE:
                await openHilPomFile()
                break
            case ButtonActions.OPEN_BUILD_LOG:
                await openBuildLogFile()
                this.messenger.sendViewBuildLog(message.tabID) // re-send to persist the button
                break
        }
    }

    // show user which project they selected in chat
    private async initiateTransformationOnProject(message: any) {
        const authType = await getAuthType()
        telemetry.codeTransform_jobIsStartedFromChatPrompt.emit({
            codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
            credentialSourceId: authType,
            result: MetadataResult.Pass,
        })
        const pathToProject: string = message.formSelectedValues['GumbyTransformProjectForm']
        const toJDKVersion: JDKVersion = message.formSelectedValues['GumbyTransformJdkToForm']
        const fromJDKVersion: JDKVersion = message.formSelectedValues['GumbyTransformJdkFromForm']
        const clientSideBuildSelection: string = message.formSelectedValues['GumbyTransformClientSideBuildForm']
        const projectName = path.basename(pathToProject)

        if (fromJDKVersion === JDKVersion.UNSUPPORTED) {
            this.messenger.sendUnrecoverableErrorResponse('unsupported-source-jdk-version', message.tabID)
            return
        }

        this.messenger.sendClientSideBuildSelectionMessage(clientSideBuildSelection, message.tabID)

        await processTransformFormInput(pathToProject, fromJDKVersion, toJDKVersion, clientSideBuildSelection)
        this.messenger.sendProjectSelectionMessage(projectName, fromJDKVersion, toJDKVersion, message.tabID)

        // at this point, buildSystems is either [Maven], [Gradle], or [Maven, Gradle]
        const buildSystems = await checkBuildSystem(pathToProject)
        let selectedBuildSystem = undefined
        if (buildSystems.length === 1) {
            selectedBuildSystem = buildSystems[0]
        } else {
            // multiple build systems present, so ask user to pick one
            await this.messenger.sendBuildSystemPrompt(message.tabID)
            return
        }
        getLogger().info(`Selected project uses build system: ${selectedBuildSystem}`)
        transformByQState.setBuildSystem(selectedBuildSystem)
        await this.validateBuildWithPromptOnError(message)
    }

    private async handleBuildSystemForm(message: any) {
        const selectedBuildSystem: BuildSystem = message.formSelectedValues['GumbyTransformBuildSystemForm']
        getLogger().info(`Selected project uses Maven and Gradle; user selected build system: ${selectedBuildSystem}`)
        transformByQState.setBuildSystem(selectedBuildSystem)
        this.messenger.sendBuildSystemSelectionMessage(selectedBuildSystem, message.tabID)
        // this message obj is from the build system form, not the project selection form,
        // which is fine since validateBuildWithPromptOnError just needs the tab ID here
        await this.validateBuildWithPromptOnError(message)
    }

    private async prepareProjectForSubmission(message: { pathToJavaHome: string; tabID: string }) {
        if (message.pathToJavaHome) {
            transformByQState.setJavaHome(message.pathToJavaHome)
            getLogger().info(
                `CodeTransformation: using JAVA_HOME = ${transformByQState.getJavaHome()} since source JDK does not match Maven JDK`
            )
        }
        this.messenger.sendStaticTextResponse('java-target-not-set', message.tabID)
        this.messenger.sendChatInputEnabled(message.tabID, true)
        this.messenger.sendUpdatePlaceholder(message.tabID, 'Enter the path to your Java installation.')
        this.sessionStorage.getSession().conversationState = ConversationState.PROMPT_JAVA_TARGET
    }

    private async prepareProjectForSubmissionHelper(message: any) {
        try {
            this.sessionStorage.getSession().conversationState = ConversationState.COMPILING
            this.messenger.sendCompilationInProgress(message.tabID)
            await compileProject()
        } catch (err: any) {
            this.messenger.sendUnrecoverableErrorResponse('could-not-compile-project', message.tabID)
            transformByQState.resetLocalBuildErrorLog()
            // reset state to allow "Start a new transformation" button to work
            this.sessionStorage.getSession().conversationState = ConversationState.IDLE
            throw err
        }

        this.messenger.sendCompilationFinished(message.tabID)

        const authState = await AuthUtil.instance.getChatAuthState()
        if (authState.amazonQ !== 'connected') {
            void this.messenger.sendAuthNeededExceptionMessage(authState, message.tabID)
            this.sessionStorage.getSession().isAuthenticating = true
            return
        }

        this.messenger.sendAsyncEventProgress(
            message.tabID,
            true,
            undefined,
            GumbyNamedMessages.JOB_SUBMISSION_STATUS_MESSAGE
        )
        this.messenger.sendJobSubmittedMessage(message.tabID)
        this.sessionStorage.getSession().conversationState = ConversationState.JOB_SUBMITTED
        await startTransformByQ()
    }

    private async validateBuildWithPromptOnError(message: any): Promise<void> {
        let errorCode = undefined
        try {
            await validateCanCompileProject()
        } catch (err: any) {
            if (err instanceof JavaHomeNotSetError) {
                this.sessionStorage.getSession().conversationState = ConversationState.PROMPT_JAVA_HOME
                this.messenger.sendStaticTextResponse('java-home-not-set', message.tabID)
                this.messenger.sendChatInputEnabled(message.tabID, true)
                this.messenger.sendUpdatePlaceholder(message.tabID, 'Enter the path to your Java installation.')
                return
            }
            errorCode = (err as Error).message
            throw err
        } finally {
            telemetry.codeTransform_validateProject.emit({
                passive: true,
                codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
                codeTransformBuildSystem: transformByQState.getBuildSystem()! as CodeTransformBuildSystem,
                codeTransformPreValidationError: errorCode ? 'ProjectJDKDiffersFromBuildSystemJDK' : undefined,
                result: errorCode ? MetadataResult.Fail : MetadataResult.Pass,
                reason: errorCode,
            })
        }

        await this.prepareProjectForSubmission(message)
    }

    private transformationFinished(data: { message: string | undefined; tabID: string }) {
        this.resetTransformationChatFlow()
        // at this point job is either completed, partially_completed, cancelled, or failed
        if (data.message) {
            this.messenger.sendJobFinishedMessage(data.tabID, data.message)
        }
    }

    private resetTransformationChatFlow() {
        this.sessionStorage.getSession().conversationState = ConversationState.IDLE
    }

    private startHILIntervention(data: { tabID: string; codeSnippet: string }) {
        this.sessionStorage.getSession().conversationState = ConversationState.WAITING_FOR_INPUT
        this.messenger.sendHumanInTheLoopInitialMessage(data.tabID, data.codeSnippet)
    }

    private HILPromptForDependency(data: { tabID: string; dependencies: DependencyVersions }) {
        this.messenger.sendDependencyVersionsFoundMessage(data.dependencies, data.tabID)
    }

    private HILDependencySelectionUploaded(data: { tabID: string }) {
        this.sessionStorage.getSession().conversationState = ConversationState.JOB_SUBMITTED
        this.messenger.sendHILResumeMessage(data.tabID)
    }

    private async processHumanChatMessage(data: { message: string; tabID: string }) {
        this.messenger.sendUserPrompt(data.message, data.tabID)
        this.messenger.sendChatInputEnabled(data.tabID, false)
        this.messenger.sendUpdatePlaceholder(data.tabID, 'Open a new tab to chat with Q')

        const session = this.sessionStorage.getSession()
        switch (session.conversationState) {
            case ConversationState.PROMPT_JAVA_HOME:
                {
                    const pathToJavaHome = extractPath(data.message)

                    if (pathToJavaHome) {
                        await this.prepareProjectForSubmission({
                            pathToJavaHome,
                            tabID: data.tabID,
                        })
                    } else {
                        this.messenger.sendUnrecoverableErrorResponse('invalid-java-home', data.tabID)
                    }
                }
                break
            case ConversationState.PROMPT_JAVA_TARGET:
                {
                    const pathToJavaTarget = extractPath(data.message)
                    getLogger().info(`CodeTransformation: using JAVA_TARGET = ${pathToJavaTarget}`)
                    if (pathToJavaTarget) {
                        transformByQState.setJavaTargetPath(pathToJavaTarget)
                        getLogger().info(
                            `Set java target in transformByQState to${transformByQState.getJavaTargetPath()}`
                        )
                        await this.prepareProjectForSubmissionHelper({ tabID: data.tabID })
                    } else {
                        this.messenger.sendUnrecoverableErrorResponse('invalid-java-home', data.tabID)
                    }
                }
                break
        }
    }

    private async continueJobWithSelectedDependency(message: { tabID: string; formSelectedValues: any }) {
        const selectedDependency = message.formSelectedValues['GumbyTransformDependencyForm']
        this.messenger.sendHILContinueMessage(message.tabID, selectedDependency)
        await finishHumanInTheLoop(selectedDependency)
    }

    private openLink(message: { link: string }) {
        void openUrl(vscode.Uri.parse(message.link))
    }

    private async handleError(message: { error: Error; tabID: string }) {
        if (message.error instanceof AlternateDependencyVersionsNotFoundError) {
            this.messenger.sendKnownErrorResponse('no-alternate-dependencies-found', message.tabID)
            await this.continueTransformationWithoutHIL(message)
        } else if (message.error instanceof ModuleUploadError) {
            this.resetTransformationChatFlow()
        } else if (message.error instanceof JobStartError) {
            this.resetTransformationChatFlow()
        } else if (message.error instanceof TransformationPreBuildError) {
            this.messenger.sendJobSubmittedMessage(message.tabID, true)
            this.messenger.sendAsyncEventProgress(
                message.tabID,
                true,
                undefined,
                GumbyNamedMessages.JOB_FAILED_IN_PRE_BUILD
            )
            await openBuildLogFile()
            this.messenger.sendViewBuildLog(message.tabID)
        }
    }

    private async continueTransformationWithoutHIL(message: { tabID: string }) {
        this.sessionStorage.getSession().conversationState = ConversationState.JOB_SUBMITTED
        CodeTransformTelemetryState.instance.setCodeTransformMetaDataField({
            canceledFromChat: true,
        })
        try {
            await finishHumanInTheLoop()
        } catch (err: any) {
            this.transformationFinished({ tabID: message.tabID, message: (err as Error).message })
        }

        this.messenger.sendStaticTextResponse('end-HIL-early', message.tabID)
    }
}

/**
 * Examples:
 * ```
 * extractPath("./some/path/here") => "C:/some/root/some/path/here"
 * extractPath(" ./some/path/here\n") => "C:/some/root/some/path/here"
 * extractPath("C:/some/nonexistent/path/here") => undefined
 * extractPath("C:/some/filepath/.txt") => undefined
 * ```
 *
 * @param text
 * @returns the absolute path if path points to existing folder, otherwise undefined
 */
function extractPath(text: string): string | undefined {
    const resolvedPath = path.resolve(text.trim())
    return fs.existsSync(resolvedPath) ? resolvedPath : undefined
}
