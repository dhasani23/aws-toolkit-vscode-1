import os
import sys
import subprocess
import re
# Define the repository URL (unchanged)
simple_repository_url = """maven {
    url uri("${project.projectDir}/configuration")
}
"""
simple_repository_url_kts = """maven {
    url = uri("${project.projectDir}/configuration")
}
"""
repository_url_groovy = """maven {
    url uri("${project.projectDir}/configuration")
    metadataSources {
            mavenPom()
            artifact()
        }
}
"""

repository_url_kts = """maven {
    url = uri("${project.projectDir}/configuration")
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
            def buildEnvironmentOutput = new ByteArrayOutputStream()
            exec {
                // Use the gradlew.bat wrapper from the project's directory
                commandLine "${project.projectDir}/gradlew.bat", 'buildEnvironment'
                standardOutput = buildEnvironmentOutput
            }

            def outputString = buildEnvironmentOutput.toString('UTF-8')
            def localM2Dir = new File(System.getProperty("user.home"), ".m2/repository")
            def gradleCacheDir = new File("${project.projectDir}/START/caches/modules-2/files-2.1") // Update this path
            def destinationDir = new File("${project.projectDir}/configuration")

            // Helper method to copy files to m2 format
            def copyToM2 = { File file, String group, String name, String version ->
                def m2Path = "${group.replace('.', '/')}/${name}/${version}"
                def m2Dir = new File(destinationDir, m2Path)
                m2Dir.mkdirs()
                def m2File = new File(m2Dir, file.name)
                println "this is the m2 path ${m2Path}"
                Files.copy(file.toPath(), m2File.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }

            // Helper method to search and copy artifact in m2 directory
            def searchAndCopyArtifactInM2 = { String group, String name, String version ->
                def m2Path = "${group.replace('.', '/')}/${name}/${version}"
                def artifactDir = new File(localM2Dir, m2Path)
                if (artifactDir.exists() && artifactDir.isDirectory()) {
                    println "Found artifact in local m2: ${artifactDir.path}"
                    artifactDir.listFiles().each { file ->
                        println "  Copying File: ${file.name}"
                        copyToM2(file, group, name, version)
                    }
                    return true
                }
                return false
            }

            // Helper method to search and copy artifact in Gradle cache directory
            def searchAndCopyArtifactInGradleCache = { String group, String name, String version ->
                def cachePath = "${group}/${name}/${version}"  // Path as is for Gradle cache
                def artifactDir = new File(gradleCacheDir, cachePath)
                if (artifactDir.exists() && artifactDir.isDirectory()) {
                    println "Found artifact in Gradle cache: ${artifactDir.path}"
                    artifactDir.listFiles().each { file ->
                        println "  Copying File: ${file.name}"
                        // Change path to m2 structure
                        copyToM2(file, group, name, version)
                    }
                    return true
                }
                return false
            }

            // Helper method to search and copy artifact in local m2 or Gradle cache
            def searchAndCopyArtifact = { String group, String name, String version ->
                if (!searchAndCopyArtifactInM2(group, name, version)) {
                    if (!searchAndCopyArtifactInGradleCache(group, name, version)) {
                        println "Artifact not found: ${group}:${name}:${version}"
                    }
                }
            }

            // Parse the buildEnvironment output
            println "=== Parsing buildEnvironment Output ==="
            def pattern = ~/(\S+:\S+:\S+)/
            outputString.eachLine { line ->
                def matcher = pattern.matcher(line)
                if (matcher.find()) {
                    def artifact = matcher.group(1)
                    def (group, name, version) = artifact.split(':')
                    searchAndCopyArtifact(group, name, version)
                }
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
                def destinationDir = new File("${project.projectDir}/configuration")

                // Helper method to copy files to m2 format
                def copyToM2 = { File file, String group, String name, String version ->
                    def m2Path = "${group.replace('.', '/')}/${name}"
                    def m2Dir = new File(destinationDir, m2Path)
                    m2Dir.mkdirs()
                    def m2File = new File(m2Dir, file.name)
                    Files.copy(file.toPath(), m2File.toPath(), StandardCopyOption.REPLACE_EXISTING)
                }

                // Print buildscript configurations (plugins)
                println "=== Plugins ==="
                buildscript.configurations.each { config ->
                    if (config.canBeResolved) {
                        println "Configuration: ${config.name}"
                        config.incoming.artifactView { viewConfig ->
                            viewConfig.lenient(true)
                        }.artifacts.each { artifact ->
                            def artifactPath = artifact.file.path
                            if (!artifactPath.startsWith(destinationDir.path)) {
                                println "  Transforming Dependency: ${artifact.id.componentIdentifier.displayName}, File: ${artifact.file}"
                                def parts = artifact.id.componentIdentifier.displayName.split(':')
                                if (parts.length == 3) {
                                    def (group, name, version) = parts
                                    copyToM2(artifact.file, group, name, version)
                                } else {
                                    println "Unexpected format: ${artifact.id.componentIdentifier.displayName}"
                                }
                            }
                        }
                        println ""
                    } else {
                        println "Configuration: ${config.name} cannot be resolved."
                        println ""
                    }
                }

                // Print regular project dependencies
                println "=== Dependencies ==="
                configurations.each { config ->
                    if (config.canBeResolved) {
                        println "Configuration: ${config.name}"
                        config.incoming.artifactView { viewConfig ->
                            viewConfig.lenient(true)
                        }.artifacts.each { artifact ->
                            def artifactPath = artifact.file.path
                            if (!artifactPath.startsWith(destinationDir.path)) {
                                println "  Transforming Dependency: ${artifact.id.componentIdentifier.displayName}, File: ${artifact.file}"
                                def (group, name, version) = artifact.id.componentIdentifier.displayName.split(':')
                                copyToM2(artifact.file, group, name, version)
                            }
                        }
                        println ""
                    } else {
                        println "Configuration: ${config.name} cannot be resolved."
                        println ""
                    }
                }

                // Resolve and print plugin marker artifacts
                println "=== Plugin Marker Artifacts ==="
                def pluginMarkerConfiguration = configurations.detachedConfiguration()

                // Access plugin dependencies from the buildscript block
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
                        println "  Transforming Plugin Marker: ${artifact.id.componentIdentifier.displayName}, File: ${artifact.file}"
                        def (group, name, version) = artifact.id.componentIdentifier.displayName.split(':')
                        copyToM2(artifact.file, group, name, version)
                    }
                }
            }
        }
    }
'''

copy_modules_script_content = '''
gradle.rootProject {
    ext.destDir = "$projectDir"
    ext.startDir = "$destDir/START"
    ext.finalDir = "$destDir/FINAL"

    task buildProject(type: Exec) {
        commandLine "$destDir/gradlew.bat", "build", "-p", destDir, "-g", startDir
    }

    task copyModules2 {
        dependsOn buildProject
        doLast {
            def srcDir = file("$startDir/caches/")
            def destDir = file("$finalDir/caches/")
            
            if (srcDir.exists()) {
                copy {
                    from srcDir
                    into destDir
                }
                println "modules2 folder copied successfully."
            } else {
                throw new GradleException("Failed to copy the modules2 folder: source directory does not exist.")
            }
        }
    }
}

'''

custom_init_script_content = '''
gradle.rootProject {
    task cacheToMavenLocal(type: Copy) {
        def destinationDirectory = "${project.projectDir}/configuration"
        println(destinationDirectory)
        from new File("${project.projectDir}/START", "caches/modules-2/files-2.1")
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
    if not os.path.exists(directory):
        os.makedirs(directory)
    file_path = os.path.join(directory, init_name)
    with open(file_path, 'w') as file:
        file.write(content)
    print(f'init.gradle file created successfully at {file_path}')
    return file_path

def make_gradlew_executable(gradlew_path):
    # check=True causes an Exception to be thrown on non-zero status code
    try:
        subprocess.run(['attrib', '-r', gradlew_path], check=True, text=True, capture_output=True)
        print(f'made gradlew.bat executable at {gradlew_path}')
    except Exception as e:
        print(f'e.stdout = {e.stdout}')
        print(f'e.stderr = {e.stderr}')
        print(f'e.returncode = {e.returncode}')
        print(f'e.args = {e.args}')
        raise # re-throw exception to be caught in main method

def run_gradle_task(init_script_path, directory_path, task):
    print(init_script_path)
    try:
        result = subprocess.run([f"{directory_path}/gradlew.bat", task, '--init-script', init_script_path, '-g', f"{directory_path}/START", '-p', f"{directory_path}", '--info'], check=True, text=True, capture_output=True)
    except Exception as e:
        print(f'e.stdout = {e.stdout}')
        print(f'e.stderr = {e.stderr}')
        print(f'e.returncode = {e.returncode}')
        print(f'e.args = {e.args}')
        raise # re-throw exception to be caught in main method
    

def update_build_gradle(file_path, project_dest):
    build_gradle_repo = f"""maven {{
            url uri('{project_dest}')
        }}"""
    MDE_repo = """maven {
    url uri('/ramdisk/code/configuration')
    metadataSources {
            mavenPom()
            artifact()
        }
}"""
    build_gradle_repo_with_flags = f"""maven {{
            url uri('{project_dest}/configuration')
            metadataSources {{
            mavenPom()
            artifact()
        }}
        }}"""
    with open(file_path, "r") as file:
        content = file.read()

    if simple_repository_url not in content:
        if "repositories {" in content:
            content = content.replace(
                "repositories {", f"repositories {{\n    {build_gradle_repo_with_flags} \n {MDE_repo}"
            )
        else:
            # Append repositories block at the end
            content += f"\n\nrepositories {{\n    {build_gradle_repo_with_flags}  \n {MDE_repo}\n}}\n"
        print(content)
        with open(file_path, "w") as file:
            file.write(content)
        print(f"Updated {file_path}")
    else:
        print(f"{file_path} already contains the repository URL")


def update_build_gradle_kts(file_path, project_dest):
    build_gradle_repo_with_flags = f"""maven {{
            url = uri("{project_dest}")
            metadataSources {{
            mavenPom()
            artifact()
        }}
        }}"""

    build_gradle_repo_with_flags_mde = """
    maven {
            url uri('/ramdisk/code/configuration')
            metadataSources {
            mavenPom()
            artifact()
        }
        }"""
    with open(file_path, "r") as file:
        content = file.read()

    if simple_repository_url_kts not in content:
        if "repositories {" in content:
            content = content.replace(
                "repositories {", f"repositories {{\n    {repository_url_kts} \n{build_gradle_repo_with_flags_mde}"
            )
        else:
            content += f"\n\nrepositories {{\n    {repository_url_kts} \n{build_gradle_repo_with_flags_mde}\n}}\n"
        with open(file_path, "w") as file:
            file.write(content)
        print(f"Updated {file_path}")
    else:
        print(f"{file_path} already contains the repository URL")


def update_settings_gradle(file_path, plugin_management_path):
    plugin_management_repo = f"""maven {{
            url uri('{plugin_management_path}')
        }}"""
    mde_plugin_management = """
    maven {
            url uri('/ramdisk/code/configuration')
            metadataSources {
            mavenPom()
            artifact()
        }
        }"""

    plugin_management_block = f"""pluginManagement {{
    repositories {{
        {plugin_management_repo}
        {mde_plugin_management}
    }}
}}
"""

    if not os.path.exists(file_path):
        with open(file_path, "w") as file:
            file.write(plugin_management_block)
        print(f"Created and updated {file_path}")
    else:
        with open(file_path, "r") as file:
            content = file.read()

        if "pluginManagement" not in content:
            updated_content = plugin_management_block + "\n" + content
        else:
            plugin_management_pattern = re.compile(r"pluginManagement\s*{[^}]*}")
            match = plugin_management_pattern.search(content)

            if match:
                if "repositories" not in match.group(0):
                    print(" no repositories")
                    updated_content = content.replace(
                        match.group(0),
                        match.group(0).rstrip("}")
                        + f"\n    repositories {{\n        {plugin_management_repo}\n    }}\n}}",
                        )
                else:
                    print("found repositories")
                    repositories_pattern = re.compile(r"repositories\s*{[^}]*}")
                    repositories_match = repositories_pattern.search(match.group(0))

                    if repositories_match:
                        if plugin_management_repo not in repositories_match.group(0):
                            updated_content = content.replace(
                                repositories_match.group(0),
                                repositories_match.group(0).rstrip("}")
                                + f"\n        {plugin_management_repo}\n    "
                                  f"\n        {mde_plugin_management}\n    }}",
                                )
                        else:
                            print(
                                f"{file_path} already contains the pluginManagement URL"
                            )
                            return
                    else:
                        updated_content = content
            else:
                updated_content = content

        with open(file_path, "w") as file:
            file.write(updated_content)
        print(f"Updated {file_path}")


def runUpdateConfig(directory_path):
    plugin_management_path = os.path.join(directory_path, 'configuration')
    for root, dirs, files in os.walk(directory_path):
        for file in files:
            if file == "build.gradle":
                update_build_gradle(os.path.join(root, file), directory_path)
                print(file)
            if file == "build.gradle.kts":
                update_build_gradle_kts(os.path.join(root, file), directory_path)
                print(file)
            elif file == "settings.gradle":
                update_settings_gradle(os.path.join(root, file), plugin_management_path)
                print(file)

    # Update or create the settings.gradle in the project root directory
    update_settings_gradle(
        os.path.join(directory_path, "settings.gradle"), plugin_management_path
    )



if __name__ == "__main__":
    if len(sys.argv) != 2:
        # should never happen because script is invoked correctly from toolkit
        print("Usage: python copyDepsPythonScript.py <directory_path>")
        print(f'Expected 2 arguments but got {len(sys.argv)} arguments: {sys.argv}')
        sys.exit(1)
    else:
        directory_path = sys.argv[1]
        # Print the path to the gradlew.bat executable for debugging
        gradlew_path = os.path.join(directory_path, 'gradlew.bat')
        print(f"Expected path to gradlew.bat: {gradlew_path}")

        if os.path.exists(gradlew_path):
            print("gradlew.bat executable found")
            try:
                make_gradlew_executable(gradlew_path)
            except Exception as e:
                print(f"Error making gradlew.bat executable, going to continue anyway: {e}")
        else:
            # TO-DO: get text approved
            print("gradlew.bat executable not found. Please ensure you have a Gradle wrapper at the root of your project. Run 'gradle wrapper' to generate one.")
            sys.exit(1)

        try:
            init_script_path = create_init_script(directory_path, 'copyModules-init.gradle', copy_modules_script_content)
            run_gradle_task(init_script_path, directory_path, 'copyModules2')
            custom_init_script_path = create_init_script(directory_path, 'custom-init.gradle', custom_init_script_content)
            run_gradle_task(custom_init_script_path, directory_path, 'cacheToMavenLocal')
            print_contents_path = create_init_script(directory_path, 'resolved-paths-init.gradle', print_contents)
            run_gradle_task(print_contents_path,directory_path,'printResolvedDependenciesAndTransformToM2')
            run_build_env_copy_path = create_init_script(directory_path,'buildEnv-copy-init.gradle', run_build_env_copy_content)
            run_gradle_task(run_build_env_copy_path, directory_path, 'runAndParseBuildEnvironment')
            runUpdateConfig(directory_path)
        except Exception as e:
            print(f"An error occurred: {e}")
            sys.exit(1)
    