/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path'
import { CodeWhispererStreaming, ExportResultArchiveCommandInput } from '@amzn/codewhisperer-streaming'
import { ToolkitError } from '../errors'
import { CodeTransformTelemetryState } from '../../amazonqGumby/telemetry/codeTransformTelemetryState'
import { transformByQState } from '../../codewhisperer/models/model'
import { calculateTotalLatency } from '../../amazonqGumby/telemetry/codeTransformTelemetry'
import { telemetry } from '../telemetry/telemetry'
import { fsCommon } from '../../srcShared/fs'
import { MetadataResult } from '../telemetry/telemetryClient'

/**
 * This class represents the structure of the archive returned by the ExportResultArchive endpoint
 */
export class ExportResultArchiveStructure {
    static readonly PathToSummary = path.join('summary', 'summary.md')
    static readonly PathToDiffPatch = path.join('patch', 'diff.patch')
    static readonly PathToManifest = 'manifest.json'
}

// TO-DO: combine codeTransform_logApiLatency and codeTransform_logApiError into codeTransform_logApiResult
// here and everywhere else (mostly transformApiHandler.ts)
export async function downloadExportResultArchive(
    cwStreamingClient: CodeWhispererStreaming,
    exportResultArchiveArgs: ExportResultArchiveCommandInput,
    toPath: string
) {
    const apiStartTime = Date.now()
    let totalDownloadBytes = 0
    let statusMessage = 'DownloadSucceeded'
    let result = undefined
    try {
        result = await cwStreamingClient.exportResultArchive(exportResultArchiveArgs)

        const buffer = []

        if (result.body === undefined) {
            throw new ToolkitError('Empty response from Amazon Q inline suggestions streaming service')
        }

        for await (const chunk of result.body) {
            if (chunk.binaryPayloadEvent) {
                const chunkData = chunk.binaryPayloadEvent
                if (chunkData.bytes) {
                    buffer.push(chunkData.bytes)
                    totalDownloadBytes += chunkData.bytes?.length
                }
            }
        }
        await fsCommon.writeFile(toPath, Buffer.concat(buffer))
    } catch (e: any) {
        statusMessage = (e as Error).message
        throw e
    } finally {
        telemetry.codeTransform_logApiLatency.emit({
            codeTransformApiNames: 'ExportResultArchive',
            codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId(),
            codeTransformJobId: transformByQState.getJobId(),
            codeTransformRunTimeLatency: calculateTotalLatency(apiStartTime),
            codeTransformTotalByteSize: totalDownloadBytes,
            codeTransformRequestId: result !== undefined ? result.$metadata.requestId : '',
            result: statusMessage ? MetadataResult.Fail : MetadataResult.Pass,
        })
    }
}
