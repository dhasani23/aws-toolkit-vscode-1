/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { SecurityIssueProvider } from './securityIssueProvider'
import { CodeScanIssue } from '../models/model'
import { Component } from '../../shared/telemetry/telemetry'

export class SecurityIssueCodeActionProvider extends SecurityIssueProvider implements vscode.CodeActionProvider {
    static #instance: SecurityIssueCodeActionProvider

    public static get instance() {
        return (this.#instance ??= new this())
    }

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        _context: vscode.CodeActionContext,
        _token: vscode.CancellationToken
    ): vscode.CodeAction[] {
        const codeActions: vscode.CodeAction[] = []

        for (const group of this.issues) {
            if (document.fileName !== group.filePath) {
                continue
            }

            for (const issue of group.issues) {
                const issueRange = new vscode.Range(issue.startLine, 0, issue.endLine, 0)
                if (issueRange.contains(range)) {
                    const [suggestedFix] = issue.suggestedFixes
                    if (suggestedFix) {
                        const fixIssue = new vscode.CodeAction(
                            `Amazon Q: Fix "${issue.title}"`,
                            vscode.CodeActionKind.QuickFix
                        )
                        const args: [CodeScanIssue, string, Component] = [issue, group.filePath, 'quickfix']
                        fixIssue.command = {
                            title: 'Fix with Amazon Q',
                            command: 'aws.amazonq.applySecurityFix',
                            arguments: args,
                        }
                        codeActions.push(fixIssue)
                    }
                    const openIssue = new vscode.CodeAction(
                        `Amazon Q: View details for "${issue.title}"`,
                        vscode.CodeActionKind.QuickFix
                    )
                    const args: [CodeScanIssue, string] = [issue, group.filePath]
                    openIssue.command = {
                        title: 'Open "Amazon Q Security Issue"',
                        command: 'aws.amazonq.openSecurityIssuePanel',
                        arguments: args,
                    }
                    codeActions.push(openIssue)

                    const explainWithQ = new vscode.CodeAction(
                        `Amazon Q: Explain "${issue.title}"`,
                        vscode.CodeActionKind.QuickFix
                    )
                    const explainWithQArgs = [issue]
                    explainWithQ.command = {
                        title: 'Explain with Amazon Q',
                        command: 'aws.amazonq.explainIssue',
                        arguments: explainWithQArgs,
                    }
                    codeActions.push(explainWithQ)
                }
            }
        }

        return codeActions
    }
}
