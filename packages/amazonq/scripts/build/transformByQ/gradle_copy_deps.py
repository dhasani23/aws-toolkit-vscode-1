import os
import sys
import subprocess
import re
from pathlib import Path

use_offline_dependency = """
final addDownloadedDependenciesRepository(rooted, receiver) {
  receiver.repositories.maven {
    url uri("${rooted.rootDir}/qct-gradle/configuration")
    metadataSources {
      mavenPom()
      artifact()
    }
  }
}
 
settingsEvaluated { settings ->
  addDownloadedDependenciesRepository settings, settings.buildscript
  addDownloadedDependenciesRepository settings, settings.pluginManagement
}
 
allprojects { project ->
  addDownloadedDependenciesRepository project, project.buildscript
  addDownloadedDependenciesRepository project, project
}
"""

# Define the repository URL (unchanged)
simple_repository_url = """maven {
    url uri("${project.projectDir}/qct-gradle/configuration")
}
"""
simple_repository_url_kts = """maven {
    url = uri("${project.projectDir}/qct-gradle/configuration")
}
"""
repository_url_groovy = """maven {
    url uri("${project.projectDir}/qct-gradle/configuration")
    metadataSources {
            mavenPom()
            artifact()
        }
}
"""

repository_url_kts = """maven {
    url = uri("${project.projectDir}/qct-gradle/configuration")
metadataSources {
    mavenPom()
artifact()
}
}
"""


run_build_env_copy_content = '''
import java.nio.file.Files
import java.nio.file.StandardCopyOption
 
gradle.rootProject {
    // Task to run buildEnvironment and capture its output
    task runAndParseBuildEnvironment {
        doLast {
            try {
                def buildEnvironmentOutput = new ByteArrayOutputStream()
                exec {
                    // Use the gradlew wrapper from the project's directory
                    commandLine "${project.projectDir}/gradlew", 'buildEnvironment'
                    standardOutput = buildEnvironmentOutput
                }

                def outputString = buildEnvironmentOutput.toString('UTF-8')
                def localM2Dir = new File(System.getProperty("user.home"), ".m2/repository")
                def gradleCacheDir = new File("${project.projectDir}/qct-gradle/START/caches/modules-2/files-2.1")
                def destinationDir = new File("${project.projectDir}/qct-gradle/configuration")

                // Helper method to copy files to m2 format
                def copyToM2 = { File file, String group, String name, String version ->
                    try {
                        def m2Path = "${group.replace('.', '/')}/${name}/${version}"
                        def m2Dir = new File(destinationDir, m2Path)
                        m2Dir.mkdirs()
                        def m2File = new File(m2Dir, file.name)
                        println "this is the m2 path ${m2Path}"
                        Files.copy(file.toPath(), m2File.toPath(), StandardCopyOption.REPLACE_EXISTING)
                    } catch (Exception e) {
                        println "Failed to copy file ${file.name} to M2 format: ${e.message}"
                    }
                }

                // Helper method to search and copy artifact in m2 directory
                def searchAndCopyArtifactInM2 = { String group, String name, String version ->
                    try {
                        def m2Path = "${group.replace('.', '/')}/${name}/${version}"
                        def artifactDir = new File(localM2Dir, m2Path)
                        if (artifactDir.exists() && artifactDir.isDirectory()) {
                            println "Found artifact in local m2: ${artifactDir.path}"
                            artifactDir.listFiles().each { file ->
                                try {
                                    println "  Copying File: ${file.name}"
                                    copyToM2(file, group, name, version)
                                } catch (Exception e) {
                                    println "Error copying file ${file.name}: ${e.message}"
                                }
                            }
                            return true
                        }
                    } catch (Exception e) {
                        println "Error searching artifact in local m2: ${e.message}"
                    }
                    return false
                }

                // Helper method to search and copy artifact in Gradle cache directory
                def searchAndCopyArtifactInGradleCache = { String group, String name, String version ->
                    try {
                        def cachePath = "${group}/${name}/${version}"  // Path as is for Gradle cache
                        def artifactDir = new File(gradleCacheDir, cachePath)
                        if (artifactDir.exists() && artifactDir.isDirectory()) {
                            println "Found artifact in Gradle cache: ${artifactDir.path}"
                            artifactDir.listFiles().each { file ->
                                try {
                                    println "  Copying File: ${file.name}"
                                    // Change path to m2 structure
                                    copyToM2(file, group, name, version)
                                } catch (Exception e) {
                                    println "Error copying file ${file.name}: ${e.message}"
                                }
                            }
                            return true
                        }
                    } catch (Exception e) {
                        println "Error searching artifact in Gradle cache: ${e.message}"
                    }
                    return false
                }

                // Helper method to search and copy artifact in local m2 or Gradle cache
                def searchAndCopyArtifact = { String group, String name, String version ->
                    try {
                        if (!searchAndCopyArtifactInM2(group, name, version)) {
                            if (!searchAndCopyArtifactInGradleCache(group, name, version)) {
                                println "Artifact not found: ${group}:${name}:${version}"
                            }
                        }
                    } catch (Exception e) {
                        println "Error searching and copying artifact: ${e.message}"
                    }
                }

                // Parse the buildEnvironment output
                println "=== Parsing buildEnvironment Output ==="
                def pattern = ~/(\S+:\S+:\S+)/
                outputString.eachLine { line ->
                    try {
                        def matcher = pattern.matcher(line)
                        if (matcher.find()) {
                            def artifact = matcher.group(1)
                            def (group, name, version) = artifact.split(':')
                            searchAndCopyArtifact(group, name, version)
                        }
                    } catch (Exception e) {
                        println "Error parsing line: ${line}, ${e.message}"
                    }
                }
            } catch (Exception e) {
                println "Error running buildEnvironment task: ${e.message}"
            }
        }
    }
}
'''

print_contents = '''
 
    import java.nio.file.Files
    import java.nio.file.Path
    import java.nio.file.StandardCopyOption
 
gradle.rootProject {
    task printResolvedDependenciesAndTransformToM2 {
        doLast {
            def destinationDir = new File("${project.projectDir}/qct-gradle/configuration")
    
            // Helper method to copy files to m2 format
            def copyToM2 = { File file, String group, String name, String version ->
                try {
                    def m2Path = "${group.replace('.', '/')}/${name}"
                    def m2Dir = new File(destinationDir, m2Path)
                    m2Dir.mkdirs()
                    def m2File = new File(m2Dir, file.name)
                    Files.copy(file.toPath(), m2File.toPath(), StandardCopyOption.REPLACE_EXISTING)
                } catch (Exception e) {
                    println "Failed to copy file ${file.name} to M2 format: ${e.message}"
                }
            }
    
            // Print buildscript configurations (plugins)
            println "=== Plugins ==="
            buildscript.configurations.each { config ->
                try {
                    if (config.canBeResolved) {
                        println "Configuration: ${config.name}"
                        config.incoming.artifactView { viewConfig ->
                            viewConfig.lenient(true)
                        }.artifacts.each { artifact ->
                            def artifactPath = artifact.file.path
                            if (!artifactPath.startsWith(destinationDir.path)) {
                                try {
                                    println "  Transforming Dependency: ${artifact.id.componentIdentifier.displayName}, File: ${artifact.file}"
                                    def parts = artifact.id.componentIdentifier.displayName.split(':')
                                    if (parts.length == 3) {
                                        def (group, name, version) = parts
                                        copyToM2(artifact.file, group, name, version)
                                    } else {
                                        println "Unexpected format: ${artifact.id.componentIdentifier.displayName}"
                                    }
                                } catch (Exception e) {
                                    println "Error processing artifact ${artifact.file}: ${e.message}"
                                }
                            }
                        }
                        println ""
                    } else {
                        println "Configuration: ${config.name} cannot be resolved."
                        println ""
                    }
                } catch (Exception e) {
                    println "Error processing configuration ${config.name}: ${e.message}"
                }
            }
    
            // Print regular project dependencies
            println "=== Dependencies ==="
            configurations.each { config ->
                try {
                    if (config.canBeResolved) {
                        println "Configuration: ${config.name}"
                        config.incoming.artifactView { viewConfig ->
                            viewConfig.lenient(true)
                        }.artifacts.each { artifact ->
                            def artifactPath = artifact.file.path
                            if (!artifactPath.startsWith(destinationDir.path)) {
                                try {
                                    println "  Transforming Dependency: ${artifact.id.componentIdentifier.displayName}, File: ${artifact.file}"
                                    def (group, name, version) = artifact.id.componentIdentifier.displayName.split(':')
                                    copyToM2(artifact.file, group, name, version)
                                } catch (Exception e) {
                                    println "Error processing artifact ${artifact.file}: ${e.message}"
                                }
                            }
                        }
                        println ""
                    } else {
                        println "Configuration: ${config.name} cannot be resolved."
                        println ""
                    }
                } catch (Exception e) {
                    println "Error processing configuration ${config.name}: ${e.message}"
                }
            }
    
            // Resolve and print plugin marker artifacts
            println "=== Plugin Marker Artifacts ==="
            def pluginMarkerConfiguration = configurations.detachedConfiguration()
    
            // Access plugin dependencies from the buildscript block
            try {
                buildscript.configurations.classpath.resolvedConfiguration.firstLevelModuleDependencies.each { dependency ->
                    dependency.children.each { transitiveDependency ->
                        def pluginArtifact = "${transitiveDependency.moduleGroup}:${transitiveDependency.moduleName}:${transitiveDependency.moduleVersion}"
                        pluginMarkerConfiguration.dependencies.add(dependencies.create(pluginArtifact))
                    }
                }
    
                pluginMarkerConfiguration.incoming.artifactView { viewConfig ->
                    viewConfig.lenient(true)
                }.artifacts.each { artifact ->
                    def artifactPath = artifact.file.path
                    if (!artifactPath.startsWith(destinationDir.path)) {
                        try {
                            println "  Transforming Plugin Marker: ${artifact.id.componentIdentifier.displayName}, File: ${artifact.file}"
                            def (group, name, version) = artifact.id.componentIdentifier.displayName.split(':')
                            copyToM2(artifact.file, group, name, version)
                        } catch (Exception e) {
                            println "Error processing plugin marker artifact ${artifact.file}: ${e.message}"
                        }
                    }
                }
            } catch (Exception e) {
                println "Error resolving plugin marker artifacts: ${e.message}"
            }
        }
    }
}
'''

copy_modules_script_content = '''
gradle.rootProject {
    ext.destDir = "$projectDir"
    ext.startDir = "$destDir/qct-gradle/START"
    ext.finalDir = "$destDir/qct-gradle/FINAL"
 
    task buildProject(type: Exec) {
        commandLine "$destDir/gradlew", "build", "-p", destDir, "-g", startDir
    }
 
    task copyModules2 {
        dependsOn buildProject
        doLast {
            def srcDir = file("$startDir/caches/modules-2/files-2.1/")
            def destDir = file("$finalDir/caches/modules-2/files-2.1/")
            
            if (srcDir.exists()) {
                copy {
                    from srcDir
                    into destDir
                }
                println "modules-2/files-2.1 folder copied successfully."
            } else {
                throw new GradleException("Failed to copy the modules-2/files-2.1 folder: source directory does not exist.")
            }
        }
    }
}
 
'''

custom_init_script_content = '''
gradle.rootProject {
    task cacheToMavenLocal(type: Sync) {
        def destinationDirectory = "${project.projectDir}/qct-gradle/configuration"
        println(destinationDirectory)
        from new File("${project.projectDir}/qct-gradle/START", "caches/modules-2/files-2.1")
        into destinationDirectory
        eachFile {
            List<String> parts = it.path.split('/')
            println(parts)
            it.path = [parts[0].replace('.','/'), parts[1], parts[2], parts[4]].join('/')
        }
        includeEmptyDirs false
    }
}
'''

def create_init_script(directory, init_name, content):
    qct_gradle_dir = os.path.join(directory, 'qct-gradle')
    os.makedirs(qct_gradle_dir, exist_ok=True)
    file_path = os.path.join(qct_gradle_dir, init_name)
    with open(file_path, 'w') as file:
        file.write(content)
    print(f'init.gradle file created successfully at {file_path}')
    return file_path

def make_gradlew_executable(gradlew_path):
    # check=True causes an Exception to be thrown on non-zero status code
    try:
        subprocess.run(['chmod', '+x', gradlew_path], check=True, text=True, capture_output=True)
        print(f'made gradlew executable at {gradlew_path}')
    except Exception as e:
        print(f'e.stdout = {e.stdout}')
        print(f'e.stderr = {e.stderr}')
        print(f'e.returncode = {e.returncode}')
        print(f'e.args = {e.args}')
        raise # re-throw exception to be caught below

def run_gradle_task(init_script_path, directory_path, task):
    try:
        result = subprocess.run([f"{directory_path}/gradlew", task, '--init-script', init_script_path, '-g', f"{directory_path}/qct-gradle/START", '-p', f"{directory_path}", '--info'], check=True, text=True, capture_output=True)
    except Exception as e:
        print(f'task failed: {task}')
        print(f'e.stdout = {e.stdout}')
        print(f'e.stderr = {e.stderr}')
        print(f'e.returncode = {e.returncode}')
        print(f'e.args = {e.args}')
        raise # re-throw exception to be caught below

def run_offline_build(init_script_path, directory_path):
    try:
        result = subprocess.run(
            [f"{directory_path}/gradlew", 'build', '--init-script', init_script_path, '-g', f"{directory_path}/qct-gradle/FINAL", '-p', f"{directory_path}", '--offline'],
            check=True, text=True, capture_output=True
        )
        print("run_offline_build() succeeded:")
        print(result.stdout)
    except Exception as e:
        print(f'e.stdout = {e.stdout}')
        print(f'e.stderr = {e.stderr}')
        print(f'e.returncode = {e.returncode}')
        print(f'e.args = {e.args}')
        raise

def create_run_task(path, init_file_name, content, task_name):
    init_script_path = create_init_script(path, init_file_name, content)
    run_gradle_task(init_script_path, path, task_name)

def run(directory_path):
    gradlew_path = os.path.join(directory_path, 'gradlew')
    if os.path.exists(gradlew_path):
        print("gradlew executable found")
        try:
            make_gradlew_executable(gradlew_path)
        except Exception as e:
            print(f"Error making gradlew executable, going to continue anyway: {e}")
    else:
        # TO-DO: get text approved
        print("gradlew executable not found. Please ensure you have a Gradle wrapper at the root of your project. Run 'gradle wrapper' to generate one.")
        sys.exit(1)
    try:
        create_run_task(directory_path, 'copyModules-init.gradle', copy_modules_script_content, 'copyModules2')
        create_run_task(directory_path, 'custom-init.gradle', custom_init_script_content, 'cacheToMavenLocal')
        create_run_task(directory_path, 'resolved-paths-init.gradle', print_contents, 'printResolvedDependenciesAndTransformToM2')
        create_run_task(directory_path, 'custom-init.gradle', custom_init_script_content, 'cacheToMavenLocal')
        create_run_task(directory_path,'buildEnv-copy-init.gradle', run_build_env_copy_content, 'runAndParseBuildEnvironment')
        build_offline_dependencies = create_init_script(directory_path, 'use-downloaded-dependencies.gradle', use_offline_dependency)
        # run_offline_build(build_offline_dependencies, directory_path)
    except Exception as e:
        print(f"An error occurred: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 2:
        # should never happen because script is invoked correctly from toolkit
        print("Usage: python copyDepsPythonScript.py <directory_path>")
        print(f'Expected 2 arguments but got {len(sys.argv)} arguments: {sys.argv}')
        sys.exit(1) # set return code to non-zero value
    else:
        directory_path = sys.argv[1]
        run(directory_path)
