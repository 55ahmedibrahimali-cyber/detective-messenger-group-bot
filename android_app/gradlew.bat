@echo off
set JAVA_HOME=C:\Users\moham\Downloads\jdk17\jdk-17.0.21.1+2
set ANDROID_HOME=C:\Users\moham\android-sdk
set GRADLE_OPTS=-Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8 %GRADLE_OPTS%
"%JAVA_HOME%\bin\java.exe" -Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8 -cp "%~dp0gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain %*
