/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 */

import { ToolkitError } from '../shared/errors'

export class JavaHomeNotSetError extends ToolkitError {
    constructor() {
        super('Java Home Is Not Set', { code: 'JavaHomeNotFound' })
    }
}

export class NoOpenProjectsError extends ToolkitError {
    constructor() {
        super('No Java projects found since no projects are open', { code: 'NoOpenProjects' })
    }
}

export class NoJavaProjectsFoundError extends ToolkitError {
    constructor() {
        super('No Java projects found', { code: 'CouldNotFindJavaProject' })
    }
}

export class NoMavenOrGradleJavaProjectsFoundError extends ToolkitError {
    constructor() {
        super('No valid Maven or Gradle build file found', { code: 'CouldNotFindPomXmlOrBuildGradle' })
    }
}

export class ZipExceedsSizeLimitError extends ToolkitError {
    constructor() {
        super('Zip file exceeds size limit', { code: 'ZipFileExceedsSizeLimit' })
    }
}

export class AlternateDependencyVersionsNotFoundError extends Error {
    constructor() {
        super('No available versions for dependency update')
    }
}

export class JobStoppedError extends Error {
    constructor(readonly requestId: string) {
        super('Job was rejected, stopped, or failed')
    }
}

export class TransformationPreBuildError extends Error {
    constructor() {
        super('Job failed to build after submission')
    }
}

export class ModuleUploadError extends Error {
    constructor() {
        super('Failed to upload module to S3')
    }
}

export class JobStartError extends Error {
    constructor() {
        super('Failed to start job')
    }
}

export class PollJobError extends Error {
    constructor() {
        super('Poll job failed')
    }
}
