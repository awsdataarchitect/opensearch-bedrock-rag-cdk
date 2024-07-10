# Use an official Python runtime as a parent image
FROM python:3.10

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy the current directory contents into the container at /usr/src/app
COPY . .

# Set environment variables for OpenSearch
ARG opensearch_host
ARG vector_index_name
ARG vector_field_name

ENV opensearch_host=$opensearch_host
ENV vector_index_name=$vector_index_name
ENV vector_field_name=$vector_field_name

# Install any needed packages specified in requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Make the script executable
RUN chmod +x /usr/src/app/start.sh

# Use the script as the entry point
CMD ["sh", "-c", "./start.sh"]